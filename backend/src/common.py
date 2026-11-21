"""Utilidades compartidas por las Lambdas de TripPlanner AI.

Cada Lambda atiende dos tipos de invocación:

1. API Gateway (HTTP API v2) -> canal 1, operaciones de negocio desde el frontend.
   El usuario se obtiene de los claims del JWT de Cognito ya validado por el autorizador.
2. Invocación directa desde el Orchestrator Agent (Tools de negocio) -> canal 2.
   Payload: {"source": "agent-tool", "action": "...", "userId": "<sub>", "params": {...}}.
   Solo el rol de ejecución del Orchestrator tiene lambda:InvokeFunction sobre estas funciones,
   y el userId proviene del JWT validado por AgentCore (nunca del modelo).
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Callable

import boto3
from boto3.dynamodb.conditions import Key

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ.get("TABLE_NAME", "tripplanner-data")
_table = None


def table():
    global _table
    if _table is None:
        _table = boto3.resource("dynamodb").Table(TABLE_NAME)
    return _table


# --------------------------------------------------------------------------- errores


class AppError(Exception):
    status = 500
    code = "INTERNAL_ERROR"

    def __init__(self, message: str, details: Any = None):
        super().__init__(message)
        self.message = message
        self.details = details


class ValidationError(AppError):
    status = 400
    code = "VALIDATION_ERROR"


class NotFoundError(AppError):
    status = 404
    code = "NOT_FOUND"


class ForbiddenError(AppError):
    status = 403
    code = "FORBIDDEN"


class UnauthorizedError(AppError):
    status = 401
    code = "UNAUTHORIZED"


# --------------------------------------------------------------------------- utilidades


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def user_pk(user_id: str) -> str:
    return f"USER#{user_id}"


def to_json(value: Any) -> str:
    def default(obj):
        if isinstance(obj, Decimal):
            return int(obj) if obj == obj.to_integral_value() else float(obj)
        if isinstance(obj, set):
            return sorted(obj)
        raise TypeError(f"No serializable: {type(obj)!r}")

    return json.dumps(value, default=default, ensure_ascii=False)


def to_plain(value: Any) -> Any:
    """Convierte Decimals de DynamoDB a int/float (para devolver al agente)."""
    return json.loads(to_json(value))


def to_dynamo(value: Any) -> Any:
    """Convierte floats a Decimal (DynamoDB no acepta float)."""
    return json.loads(to_json(value), parse_float=Decimal)


def strip_keys(item: dict | None) -> dict | None:
    if item is None:
        return None
    return {k: v for k, v in item.items() if k not in ("PK", "SK")}


def query_prefix(user_id: str, prefix: str) -> list[dict]:
    items: list[dict] = []
    kwargs = {
        "KeyConditionExpression": Key("PK").eq(user_pk(user_id)) & Key("SK").begins_with(prefix)
    }
    while True:
        resp = table().query(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            return items
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def get_item(user_id: str, sk: str) -> dict | None:
    return table().get_item(Key={"PK": user_pk(user_id), "SK": sk}).get("Item")


# --------------------------------------------------------------------------- validación

CARD_PATTERN = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")
CVV_KEYS = {"cvv", "cvc", "card", "cardnumber", "tarjeta", "numerotarjeta", "pan", "expiry"}


def reject_payment_data(value: Any, path: str = "") -> None:
    """Prohibido almacenar datos de tarjetas: rechaza claves o valores con aspecto de tarjeta."""
    if isinstance(value, dict):
        for key, inner in value.items():
            normalized = re.sub(r"[^a-z]", "", str(key).lower())
            if normalized in CVV_KEYS:
                raise ValidationError(
                    "TripPlanner no acepta ni almacena datos de pago (tarjetas, CVV)."
                )
            reject_payment_data(inner, f"{path}.{key}")
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            reject_payment_data(inner, f"{path}[{index}]")
    elif isinstance(value, str) and CARD_PATTERN.search(value):
        digits = re.sub(r"\D", "", CARD_PATTERN.search(value).group(0))
        if _luhn_ok(digits):
            raise ValidationError(
                "TripPlanner no acepta ni almacena datos de pago (tarjetas, CVV)."
            )


def _luhn_ok(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        number = int(char)
        if index % 2 == 1:
            number *= 2
            if number > 9:
                number -= 9
        total += number
    return len(digits) >= 13 and total % 10 == 0


def req_str(data: dict, key: str, max_len: int = 120, required: bool = True) -> str | None:
    value = data.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ValidationError(f"El campo '{key}' es obligatorio.")
        return None
    if not isinstance(value, str):
        raise ValidationError(f"El campo '{key}' debe ser texto.")
    value = value.strip()
    if len(value) > max_len:
        raise ValidationError(f"El campo '{key}' supera {max_len} caracteres.")
    return value


def req_date(data: dict, key: str, required: bool = True) -> str | None:
    value = req_str(data, key, 10, required)
    if value is None:
        return None
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValidationError(f"El campo '{key}' debe tener formato YYYY-MM-DD.") from exc


def req_int(data: dict, key: str, low: int, high: int, required: bool = True) -> int | None:
    value = data.get(key)
    if value is None or value == "":
        if required:
            raise ValidationError(f"El campo '{key}' es obligatorio.")
        return None
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"El campo '{key}' debe ser un número entero.") from exc
    if isinstance(value, float) and value != number:
        raise ValidationError(f"El campo '{key}' debe ser un número entero.")
    if not low <= number <= high:
        raise ValidationError(f"El campo '{key}' debe estar entre {low} y {high}.")
    return number


def req_money(data: dict, key: str, required: bool = False, high: float = 1e12) -> Decimal | None:
    value = data.get(key)
    if value is None or value == "":
        if required:
            raise ValidationError(f"El campo '{key}' es obligatorio.")
        return None
    try:
        number = Decimal(str(value))
    except Exception as exc:  # noqa: BLE001
        raise ValidationError(f"El campo '{key}' debe ser numérico.") from exc
    if number.is_nan() or number < 0 or number > Decimal(str(high)):
        raise ValidationError(f"El campo '{key}' debe ser un valor entre 0 y {high:,.0f}.")
    return number


def req_enum(data: dict, key: str, allowed: set[str], required: bool = True, default: str | None = None) -> str | None:
    value = data.get(key, default)
    if value is None or value == "":
        if required:
            raise ValidationError(f"El campo '{key}' es obligatorio.")
        return default
    value = str(value).strip().upper()
    if value not in allowed:
        raise ValidationError(
            f"El campo '{key}' debe ser uno de: {', '.join(sorted(allowed))}."
        )
    return value


def str_list(data: dict, key: str, max_items: int = 20, max_len: int = 60) -> list[str] | None:
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, str):
        value = [part.strip() for part in value.split(",") if part.strip()]
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValidationError(f"El campo '{key}' debe ser una lista de textos.")
    if len(value) > max_items:
        raise ValidationError(f"El campo '{key}' admite máximo {max_items} elementos.")
    return [v.strip()[:max_len] for v in value if v.strip()]


CURRENCIES = {"COP", "USD", "EUR", "MXN", "PEN", "CLP", "ARS", "BRL"}


# --------------------------------------------------------------------------- despacho


def _parse_api_event(event: dict) -> tuple[str, str, dict, dict, dict]:
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    user_id = claims.get("sub")
    if not user_id:
        raise UnauthorizedError("Token de autenticación inválido o ausente.")
    body: dict = {}
    raw = event.get("body")
    if raw:
        if event.get("isBase64Encoded"):
            import base64

            raw = base64.b64decode(raw).decode("utf-8")
        if len(raw) > 64_000:
            raise ValidationError("El cuerpo de la petición es demasiado grande.")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValidationError("El cuerpo de la petición no es JSON válido.") from exc
        if not isinstance(body, dict):
            raise ValidationError("El cuerpo de la petición debe ser un objeto JSON.")
    params = dict(event.get("queryStringParameters") or {})
    params.update(event.get("pathParameters") or {})
    params.update(body)
    return event.get("routeKey", ""), user_id, params, claims, body


def http_response(status: int, body: Any) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
        "body": to_json(body),
    }


def make_handler(
    actions: dict[str, Callable[[str, dict, dict], Any]],
    routes: dict[str, str],
    created_actions: set[str] | None = None,
):
    """Construye un handler Lambda que atiende API Gateway y Tools del agente."""

    created_actions = created_actions or set()

    def handler(event, _context):
        is_api = isinstance(event, dict) and "requestContext" in event
        try:
            if is_api:
                route_key, user_id, params, claims, _ = _parse_api_event(event)
                action = routes.get(route_key)
                if action is None:
                    raise NotFoundError("Ruta no encontrada.")
            else:
                if not isinstance(event, dict) or event.get("source") != "agent-tool":
                    raise ForbiddenError("Origen de invocación no permitido.")
                action = event.get("action")
                user_id = event.get("userId")
                params = event.get("params") or {}
                claims = {"sub": user_id, "email": event.get("email")}
                if action not in actions:
                    raise ValidationError(f"Acción desconocida: {action!r}.")
                if not isinstance(user_id, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,64}", user_id):
                    raise UnauthorizedError("Identidad de usuario inválida.")
                if not isinstance(params, dict):
                    raise ValidationError("params debe ser un objeto.")

            reject_payment_data(params)
            logger.info("action=%s user=%s via=%s", action, user_id, "api" if is_api else "agent")
            result = actions[action](user_id, params, claims)
            if is_api:
                return http_response(201 if action in created_actions else 200, result)
            return {"ok": True, "data": to_plain(result)}
        except AppError as exc:
            logger.warning("error %s: %s", exc.code, exc.message)
            payload = {"error": {"code": exc.code, "message": exc.message}}
            if exc.details:
                payload["error"]["details"] = exc.details
            if is_api:
                return http_response(exc.status, payload)
            return {"ok": False, **payload}
        except Exception:  # noqa: BLE001
            logger.exception("Error no controlado")
            payload = {"error": {"code": "INTERNAL_ERROR", "message": "Ocurrió un error interno. Intenta de nuevo."}}
            if is_api:
                return http_response(500, payload)
            return {"ok": False, **payload}

    return handler
