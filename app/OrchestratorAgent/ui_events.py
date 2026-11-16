"""Contexto por invocación del Orchestrator: identidad del usuario y canal de eventos de UI.

El entrypoint crea una cola asyncio por petición. Las Tools publican en ella:
- {"type": "status", "text": ...}        indicadores de procesamiento
- {"type": "ui", "block": {...}}         datos estructurados para Agent-Driven UI
- {"type": "data_changed", "entity": ...} el frontend refresca sus listados
El entrypoint los reenvía al frontend por HTTP streaming (SSE) junto con el texto del modelo.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class UserContext:
    user_id: str
    username: str = ""


current_user: ContextVar[UserContext | None] = ContextVar("current_user", default=None)
event_queue: ContextVar[asyncio.Queue | None] = ContextVar("event_queue", default=None)


def publish(event: dict) -> None:
    queue = event_queue.get()
    if queue is not None:
        queue.put_nowait(event)


def status(text: str) -> None:
    publish({"type": "status", "text": text})


def ui(block: dict) -> None:
    publish({"type": "ui", "block": block})


def changed(entity: str) -> None:
    publish({"type": "data_changed", "entity": entity})


def decode_jwt_claims(authorization: str | None) -> dict:
    """Lee los claims de un JWT ya validado por el autorizador CUSTOM_JWT de AgentCore.

    AgentCore verifica firma, emisor, expiración y client_id antes de invocar el runtime;
    aquí solo se decodifica el payload para conocer la identidad (sub) del usuario.
    """
    if not authorization or not isinstance(authorization, str):
        return {}
    token = authorization.split(" ", 1)[1] if authorization.lower().startswith("bearer ") else authorization
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    try:
        padded = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded))
    except (ValueError, json.JSONDecodeError):
        return {}
    return claims if isinstance(claims, dict) else {}


# --------------------------------------------------------------------------- vuelos

ROW_PATTERN = re.compile(
    r"^(?P<flight>[^|]+)\|(?P<airline>[^|]+)\|\s*salida\s+(?P<time>\d{1,2}:\d{2})\s*\|(?P<price>.+)$"
)
HEADER_PATTERN = re.compile(r"^(?P<date>\d{2}/\d{2}/\d{4})\s*\|\s*(?P<origin>.+?)\s*(?:→|->)\s*(?P<destination>.+)$")
AMOUNT_PATTERN = re.compile(r"(?P<prefix>[^\d\s]*)\s*(?P<amount>\d[\d,]*(?:\.\d+)?)\s*(?P<suffix>[A-Z]{3})?")


def parse_flights(text: str, origin: str = "", destination: str = "", travel_date: str = "") -> dict:
    """Convierte la salida del Flight Agent en un bloque estructurado de vuelos."""
    block: dict[str, Any] = {
        "type": "flights",
        "origin": origin,
        "destination": destination,
        "date": travel_date,
        "flights": [],
    }
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    for line in lines:
        header = HEADER_PATTERN.match(line)
        if header:
            block["origin"] = header.group("origin").strip()
            block["destination"] = header.group("destination").strip()
            try:
                block["date"] = datetime.strptime(header.group("date"), "%d/%m/%Y").date().isoformat()
            except ValueError:
                pass
            continue
        row = ROW_PATTERN.match(line)
        if not row:
            continue
        price_text = row.group("price").strip()
        cheapest = "(más barato)" in price_text
        price_text = price_text.replace("(más barato)", "").strip()
        amount_match = AMOUNT_PATTERN.search(price_text)
        amount = None
        currency = "USD"
        if amount_match:
            amount = float(amount_match.group("amount").replace(",", ""))
            prefix = amount_match.group("prefix") or ""
            suffix = amount_match.group("suffix")
            currency = suffix or ("USD" if prefix in ("$", "US$", "") else prefix)
        flight_codes = row.group("flight").strip()
        block["flights"].append(
            {
                "flight": flight_codes,
                "airline": row.group("airline").strip(),
                "departure": row.group("time").zfill(5),
                "price": price_text,
                "amount": amount,
                "currency": currency,
                "stops": max(0, len([c for c in flight_codes.split("/") if c.strip()]) - 1),
                "cheapest": cheapest,
            }
        )
    if not block["flights"]:
        block["message"] = lines[0] if lines else "Sin resultados de vuelos."
    return block


def parse_weather(text: str) -> dict:
    """Convierte la salida JSON del Weather Agent en un bloque de clima."""
    raw = str(text).strip()
    start, end = raw.find("{"), raw.rfind("}")
    try:
        data = json.loads(raw[start : end + 1]) if start != -1 and end != -1 else {}
    except json.JSONDecodeError:
        data = {}
    if not isinstance(data, dict) or not data:
        return {"type": "weather", "days": [], "message": raw[:300] or "Clima no disponible."}
    data["type"] = "weather"
    data.setdefault("days", [])
    return data
