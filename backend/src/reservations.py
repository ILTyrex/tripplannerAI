"""Lambda de reservas: CreateReservation, GetReservations, UpdateReservation.

Las reservas son SIMULADAS (sin proveedor externo) pero se persisten en DynamoDB.
Estados: SIMULADA, PENDIENTE, CONFIRMADA (solo proveedor real), CANCELADA.
"""

import secrets

from common import (
    CURRENCIES,
    NotFoundError,
    ValidationError,
    get_item,
    make_handler,
    new_id,
    now_iso,
    query_prefix,
    req_date,
    req_enum,
    req_int,
    req_money,
    req_str,
    strip_keys,
    table,
    user_pk,
)
import re

TYPES = {"FLIGHT", "HOTEL", "ACTIVITY"}
STATUSES = {"SIMULADA", "PENDIENTE", "CONFIRMADA", "CANCELADA"}
# CONFIRMADA solo la puede asignar un proveedor real. Este sistema no integra proveedores,
# así que ni el frontend ni el agente pueden fijarla.
CLIENT_STATUSES = {"SIMULADA", "PENDIENTE", "CANCELADA"}
TYPE_ALIASES = {
    "VUELO": "FLIGHT", "FLIGHTS": "FLIGHT", "HOTELES": "HOTEL", "HOSPEDAJE": "HOTEL",
    "ACTIVIDAD": "ACTIVITY", "ACTIVIDADES": "ACTIVITY", "TOUR": "ACTIVITY",
}
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _type(params: dict) -> str:
    raw = str(params.get("type", "")).strip().upper()
    params = {**params, "type": TYPE_ALIASES.get(raw, raw)}
    return req_enum(params, "type", TYPES)


def _status(params: dict, default: str | None) -> str | None:
    status = req_enum(params, "status", STATUSES, required=False, default=default)
    if status == "CONFIRMADA":
        raise ValidationError(
            "El estado CONFIRMADA solo lo asigna un proveedor real. "
            "Las reservas de TripPlanner son simuladas (SIMULADA) o PENDIENTE."
        )
    return status


def _time(params: dict) -> str | None:
    value = req_str(params, "time", 5, required=False)
    if value and not TIME_PATTERN.match(value):
        raise ValidationError("'time' debe tener formato HH:MM.")
    return value


def _trip(user_id: str, trip_id) -> dict:
    trip_id = req_str({"tripId": trip_id}, "tripId", 40)
    trip = get_item(user_id, f"TRIP#{trip_id}")
    if trip is None:
        raise NotFoundError(f"No existe el viaje {trip_id} para este usuario.")
    return trip


def create_reservation(user_id: str, params: dict, claims: dict) -> dict:
    trip = _trip(user_id, params.get("tripId"))
    res_type = _type(params)
    res_date = req_date(params, "date")
    if not trip["startDate"] <= res_date <= trip["endDate"]:
        # Un vuelo de ida puede ser el mismo día de salida; se exige que esté dentro del viaje.
        raise ValidationError(
            f"La fecha {res_date} está fuera del viaje ({trip['startDate']} a {trip['endDate']})."
        )
    reservation_id = new_id("res")
    item = {
        "PK": user_pk(user_id),
        "SK": f"RES#{reservation_id}",
        "entityType": "RESERVATION",
        "reservationId": reservation_id,
        "tripId": trip["tripId"],
        "tripTitle": trip.get("title", ""),
        "type": res_type,
        "title": req_str(params, "title", 120),
        "provider": req_str(params, "provider", 80, required=False) or "",
        "date": res_date,
        "time": _time(params) or "",
        "endDate": req_date(params, "endDate", required=False) or "",
        "location": req_str(params, "location", 120, required=False) or "",
        "details": req_str(params, "details", 500, required=False) or "",
        "quantity": req_int(params, "quantity", 1, 50, required=False) or trip.get("travelers", 1),
        "price": req_money(params, "price"),
        "currency": req_enum(params, "currency", CURRENCIES, required=False, default="COP"),
        "status": _status(params, "SIMULADA"),
        "simulated": True,
        "confirmationCode": "SIM-" + secrets.token_hex(3).upper(),
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    item = {k: v for k, v in item.items() if v is not None}
    table().put_item(Item=item, ConditionExpression="attribute_not_exists(SK)")
    return strip_keys(item)


def get_reservations(user_id: str, params: dict, claims: dict) -> dict:
    items = [strip_keys(r) for r in query_prefix(user_id, "RES#")]
    if params.get("tripId"):
        items = [r for r in items if r.get("tripId") == params["tripId"]]
    if params.get("status"):
        items = [r for r in items if r.get("status") == str(params["status"]).upper()]
    if params.get("type"):
        wanted = TYPE_ALIASES.get(str(params["type"]).upper(), str(params["type"]).upper())
        items = [r for r in items if r.get("type") == wanted]
    items.sort(key=lambda r: r.get("createdAt", ""), reverse=True)
    return {"reservations": items, "count": len(items)}


def update_reservation(user_id: str, params: dict, claims: dict) -> dict:
    reservation_id = req_str(params, "reservationId", 40)
    current = get_item(user_id, f"RES#{reservation_id}")
    if current is None:
        raise NotFoundError(f"No existe la reserva {reservation_id} para este usuario.")
    changes: dict = {}
    trip = None
    if "tripId" in params and params["tripId"] != current.get("tripId"):
        trip = _trip(user_id, params["tripId"])
        changes["tripId"] = trip["tripId"]
        changes["tripTitle"] = trip.get("title", "")
    if "type" in params:
        changes["type"] = _type(params)
    if "status" in params:
        changes["status"] = _status(params, None)
    for key, max_len in (("title", 120), ("provider", 80), ("location", 120), ("details", 500)):
        if key in params:
            changes[key] = req_str(params, key, max_len, required=key == "title") or ""
    if "date" in params:
        changes["date"] = req_date(params, "date")
    if "endDate" in params:
        changes["endDate"] = req_date(params, "endDate", required=False) or ""
    if "time" in params:
        changes["time"] = _time(params) or ""
    if "price" in params:
        changes["price"] = req_money(params, "price", required=True)
    if "currency" in params:
        changes["currency"] = req_enum(params, "currency", CURRENCIES)
    if "quantity" in params:
        changes["quantity"] = req_int(params, "quantity", 1, 50)
    if not changes:
        raise ValidationError("No hay campos para actualizar.")

    if "date" in changes or trip is not None:
        trip = trip or _trip(user_id, current["tripId"])
        res_date = changes.get("date", current["date"])
        if not trip["startDate"] <= res_date <= trip["endDate"]:
            raise ValidationError(
                f"La fecha {res_date} está fuera del viaje ({trip['startDate']} a {trip['endDate']})."
            )

    changes["updatedAt"] = now_iso()
    resp = table().update_item(
        Key={"PK": user_pk(user_id), "SK": f"RES#{reservation_id}"},
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in changes),
        ExpressionAttributeNames={f"#{k}": k for k in changes},
        ExpressionAttributeValues={f":{k}": v for k, v in changes.items()},
        ConditionExpression="attribute_exists(SK)",
        ReturnValues="ALL_NEW",
    )
    return strip_keys(resp["Attributes"])


ACTIONS = {
    "create_reservation": create_reservation,
    "get_reservations": get_reservations,
    "update_reservation": update_reservation,
}

ROUTES = {
    "POST /reservations": "create_reservation",
    "GET /reservations": "get_reservations",
    "PUT /reservations/{reservationId}": "update_reservation",
}

handler = make_handler(ACTIONS, ROUTES, created_actions={"create_reservation"})
