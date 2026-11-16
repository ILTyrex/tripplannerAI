"""Lambda de viajes: CreateTrip, GetTrips, UpdateTrip (+ detalle y borrado)."""

from datetime import date

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
    str_list,
    strip_keys,
    table,
    user_pk,
)

TRIP_STATUS = {"PLANIFICADO", "CONFIRMADO", "EN_CURSO", "COMPLETADO", "CANCELADO"}
MAX_TRIP_DAYS = 60


def _validate_dates(start: str, end: str) -> None:
    d1, d2 = date.fromisoformat(start), date.fromisoformat(end)
    if d2 < d1:
        raise ValidationError("La fecha de regreso no puede ser anterior a la de salida.")
    if (d2 - d1).days + 1 > MAX_TRIP_DAYS:
        raise ValidationError(f"Un viaje puede durar máximo {MAX_TRIP_DAYS} días.")
    if d1.year < 2020 or d2.year > 2100:
        raise ValidationError("Fechas fuera de rango.")


def _trip_or_404(user_id: str, trip_id: str) -> dict:
    trip_id = req_str({"tripId": trip_id}, "tripId", 40)
    item = get_item(user_id, f"TRIP#{trip_id}")
    if item is None:
        raise NotFoundError(f"No existe el viaje {trip_id} para este usuario.")
    return item


def create_trip(user_id: str, params: dict, claims: dict) -> dict:
    destination = req_str(params, "destination", 80)
    origin = req_str(params, "origin", 80, required=False)
    start = req_date(params, "startDate")
    end = req_date(params, "endDate")
    _validate_dates(start, end)
    trip_id = new_id("trip")
    item = {
        "PK": user_pk(user_id),
        "SK": f"TRIP#{trip_id}",
        "entityType": "TRIP",
        "tripId": trip_id,
        "title": req_str(params, "title", 100, required=False) or f"Viaje a {destination}",
        "origin": origin or "",
        "destination": destination,
        "startDate": start,
        "endDate": end,
        "travelers": req_int(params, "travelers", 1, 20, required=False) or 1,
        "budget": req_money(params, "budget"),
        "currency": req_enum(params, "currency", CURRENCIES, required=False, default="COP"),
        "preferences": str_list(params, "preferences") or [],
        "notes": req_str(params, "notes", 1000, required=False) or "",
        "status": req_enum(params, "status", TRIP_STATUS, required=False, default="PLANIFICADO"),
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    item = {k: v for k, v in item.items() if v is not None}
    table().put_item(Item=item, ConditionExpression="attribute_not_exists(SK)")
    return strip_keys(item)


def get_trips(user_id: str, params: dict, claims: dict) -> dict:
    trips = [strip_keys(t) for t in query_prefix(user_id, "TRIP#")]
    status = params.get("status")
    if status:
        trips = [t for t in trips if t.get("status") == str(status).upper()]
    trips.sort(key=lambda t: t.get("startDate", ""))
    return {"trips": trips, "count": len(trips)}


def get_trip(user_id: str, params: dict, claims: dict) -> dict:
    trip = _trip_or_404(user_id, params.get("tripId"))
    trip_id = trip["tripId"]
    itinerary = get_item(user_id, f"ITIN#{trip_id}")
    reservations = [
        strip_keys(r) for r in query_prefix(user_id, "RES#") if r.get("tripId") == trip_id
    ]
    reservations.sort(key=lambda r: (r.get("date", ""), r.get("time", "")))
    return {
        "trip": strip_keys(trip),
        "itinerary": strip_keys(itinerary),
        "reservations": reservations,
    }


UPDATABLE = {
    "title": lambda p: req_str(p, "title", 100),
    "origin": lambda p: req_str(p, "origin", 80),
    "destination": lambda p: req_str(p, "destination", 80),
    "startDate": lambda p: req_date(p, "startDate"),
    "endDate": lambda p: req_date(p, "endDate"),
    "travelers": lambda p: req_int(p, "travelers", 1, 20),
    "budget": lambda p: req_money(p, "budget", required=True),
    "currency": lambda p: req_enum(p, "currency", CURRENCIES),
    "preferences": lambda p: str_list(p, "preferences") or [],
    "notes": lambda p: req_str(p, "notes", 1000, required=False) or "",
    "status": lambda p: req_enum(p, "status", TRIP_STATUS),
}


def update_trip(user_id: str, params: dict, claims: dict) -> dict:
    trip = _trip_or_404(user_id, params.get("tripId"))
    changes = {k: fn(params) for k, fn in UPDATABLE.items() if k in params}
    if not changes:
        raise ValidationError(
            "No hay campos para actualizar. Campos permitidos: " + ", ".join(UPDATABLE)
        )
    start = changes.get("startDate", trip["startDate"])
    end = changes.get("endDate", trip["endDate"])
    _validate_dates(start, end)
    changes["updatedAt"] = now_iso()
    names = {f"#{k}": k for k in changes}
    values = {f":{k}": v for k, v in changes.items()}
    resp = table().update_item(
        Key={"PK": user_pk(user_id), "SK": trip["SK"]},
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in changes),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ConditionExpression="attribute_exists(SK)",
        ReturnValues="ALL_NEW",
    )
    return strip_keys(resp["Attributes"])


def delete_trip(user_id: str, params: dict, claims: dict) -> dict:
    trip = _trip_or_404(user_id, params.get("tripId"))
    trip_id = trip["tripId"]
    with table().batch_writer() as batch:
        batch.delete_item(Key={"PK": user_pk(user_id), "SK": f"TRIP#{trip_id}"})
        batch.delete_item(Key={"PK": user_pk(user_id), "SK": f"ITIN#{trip_id}"})
        for res in query_prefix(user_id, "RES#"):
            if res.get("tripId") == trip_id:
                batch.delete_item(Key={"PK": res["PK"], "SK": res["SK"]})
    return {"deleted": trip_id}


ACTIONS = {
    "create_trip": create_trip,
    "get_trips": get_trips,
    "get_trip": get_trip,
    "update_trip": update_trip,
    "delete_trip": delete_trip,
}

ROUTES = {
    "POST /trips": "create_trip",
    "GET /trips": "get_trips",
    "GET /trips/{tripId}": "get_trip",
    "PUT /trips/{tripId}": "update_trip",
    "DELETE /trips/{tripId}": "delete_trip",
}

handler = make_handler(ACTIONS, ROUTES, created_actions={"create_trip"})
