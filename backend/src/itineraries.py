"""Lambda de itinerarios: CreateItinerary, UpdateItinerary (+ consulta)."""

from datetime import date, timedelta

from common import (
    NotFoundError,
    ValidationError,
    get_item,
    make_handler,
    now_iso,
    req_money,
    req_str,
    strip_keys,
    table,
    to_dynamo,
    user_pk,
)
import re

CATEGORIES = {
    "TRANSPORTE", "HOSPEDAJE", "COMIDA", "CULTURA", "PLAYA", "NATURALEZA",
    "AVENTURA", "COMPRAS", "VIDA_NOCTURNA", "DESCANSO", "TOUR", "OTRO",
}
TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
MAX_ACTIVITIES = 15


def _trip(user_id: str, trip_id) -> dict:
    trip_id = req_str({"tripId": trip_id}, "tripId", 40)
    trip = get_item(user_id, f"TRIP#{trip_id}")
    if trip is None:
        raise NotFoundError(f"No existe el viaje {trip_id} para este usuario.")
    return trip


def _activity(raw, where: str) -> dict:
    if not isinstance(raw, dict):
        raise ValidationError(f"{where}: cada actividad debe ser un objeto.")
    time = raw.get("time")
    if time not in (None, ""):
        time = str(time).strip()
        if len(time) == 4 and time[1] == ":":
            time = "0" + time
        if not TIME_PATTERN.match(time):
            raise ValidationError(f"{where}: 'time' debe tener formato HH:MM.")
    category = str(raw.get("category") or "OTRO").strip().upper().replace(" ", "_")
    if category not in CATEGORIES:
        category = "OTRO"
    cost = req_money(raw, "estimatedCost")
    activity = {
        "time": time or "",
        "title": req_str(raw, "title", 120),
        "description": req_str(raw, "description", 500, required=False) or "",
        "location": req_str(raw, "location", 120, required=False) or "",
        "category": category,
    }
    if cost is not None:
        activity["estimatedCost"] = float(cost)
    return activity


def _days(raw_days, trip: dict) -> list[dict]:
    if not isinstance(raw_days, list) or not raw_days:
        raise ValidationError("'days' debe ser una lista no vacía de días.")
    start = date.fromisoformat(trip["startDate"])
    end = date.fromisoformat(trip["endDate"])
    total = (end - start).days + 1
    if len(raw_days) > total:
        raise ValidationError(f"El viaje dura {total} días; el itinerario tiene {len(raw_days)}.")
    days = []
    for index, raw in enumerate(raw_days, start=1):
        days.append(_day(raw, index, start, end))
    days.sort(key=lambda d: d["day"])
    if len({d["day"] for d in days}) != len(days):
        raise ValidationError("Hay días repetidos en el itinerario.")
    return days


def _day(raw, default_number: int, start: date, end: date) -> dict:
    if not isinstance(raw, dict):
        raise ValidationError("Cada día debe ser un objeto.")
    number = raw.get("day", default_number)
    try:
        number = int(number)
    except (TypeError, ValueError) as exc:
        raise ValidationError("'day' debe ser un número.") from exc
    total = (end - start).days + 1
    if not 1 <= number <= total:
        raise ValidationError(f"'day' debe estar entre 1 y {total}.")
    expected = (start + timedelta(days=number - 1)).isoformat()
    activities = raw.get("activities") or []
    if not isinstance(activities, list):
        raise ValidationError(f"Día {number}: 'activities' debe ser una lista.")
    if len(activities) > MAX_ACTIVITIES:
        raise ValidationError(f"Día {number}: máximo {MAX_ACTIVITIES} actividades.")
    parsed = [_activity(a, f"Día {number}") for a in activities]
    parsed.sort(key=lambda a: a["time"] or "99:99")
    return {
        "day": number,
        "date": expected,
        "title": req_str(raw, "title", 120, required=False) or f"Día {number}",
        "activities": parsed,
    }


def _save(user_id: str, trip: dict, days: list[dict], notes: str, created_at: str | None) -> dict:
    item = {
        "PK": user_pk(user_id),
        "SK": f"ITIN#{trip['tripId']}",
        "entityType": "ITINERARY",
        "tripId": trip["tripId"],
        "destination": trip["destination"],
        "days": to_dynamo(days),
        "notes": notes,
        "createdAt": created_at or now_iso(),
        "updatedAt": now_iso(),
    }
    table().put_item(Item=item)
    return strip_keys(item)


def create_itinerary(user_id: str, params: dict, claims: dict) -> dict:
    trip = _trip(user_id, params.get("tripId"))
    existing = get_item(user_id, f"ITIN#{trip['tripId']}")
    if existing is not None and not params.get("replace"):
        raise ValidationError(
            "El viaje ya tiene itinerario. Usa UpdateItinerary para modificarlo "
            "(o envía replace=true para reemplazarlo)."
        )
    days = _days(params.get("days"), trip)
    notes = req_str(params, "notes", 1000, required=False) or ""
    return _save(user_id, trip, days, notes, None)


def update_itinerary(user_id: str, params: dict, claims: dict) -> dict:
    trip = _trip(user_id, params.get("tripId"))
    existing = get_item(user_id, f"ITIN#{trip['tripId']}")
    if existing is None:
        raise NotFoundError("El viaje no tiene itinerario todavía. Usa CreateItinerary.")
    start = date.fromisoformat(trip["startDate"])
    end = date.fromisoformat(trip["endDate"])
    days = [dict(d) for d in existing.get("days", [])]
    if "days" in params:
        days = _days(params["days"], trip)
    elif "day" in params:
        # Reemplaza o agrega un único día.
        new_day = _day(params["day"], 1, start, end)
        days = [d for d in days if int(d["day"]) != new_day["day"]] + [new_day]
        days.sort(key=lambda d: int(d["day"]))
    elif "notes" not in params:
        raise ValidationError("Envía 'days' (itinerario completo), 'day' (un día) o 'notes'.")
    notes = req_str(params, "notes", 1000, required=False)
    if notes is None:
        notes = existing.get("notes", "")
    return _save(user_id, trip, days, notes, existing.get("createdAt"))


def get_itinerary(user_id: str, params: dict, claims: dict) -> dict:
    trip = _trip(user_id, params.get("tripId"))
    item = get_item(user_id, f"ITIN#{trip['tripId']}")
    if item is None:
        raise NotFoundError("El viaje no tiene itinerario todavía.")
    return strip_keys(item)


ACTIONS = {
    "create_itinerary": create_itinerary,
    "update_itinerary": update_itinerary,
    "get_itinerary": get_itinerary,
}

ROUTES = {
    "POST /trips/{tripId}/itinerary": "create_itinerary",
    "PUT /trips/{tripId}/itinerary": "update_itinerary",
    "GET /trips/{tripId}/itinerary": "get_itinerary",
}

handler = make_handler(ACTIONS, ROUTES, created_actions={"create_itinerary"})
