"""Tools de negocio del Orchestrator Agent.

Cada Tool está respaldada por una operación de negocio en AWS Lambda (que valida y persiste en
DynamoDB). El agente decide qué Tool usar; la Lambda ejecuta. La identidad del usuario NO la
decide el modelo: se toma del JWT validado por AgentCore (ContextVar `current_user`).

Tool                -> Lambda (acción)
CreateTrip          -> tripplanner-trips (create_trip)
GetTrips            -> tripplanner-trips (get_trips)
UpdateTrip          -> tripplanner-trips (update_trip)
GetTripDetails      -> tripplanner-trips (get_trip)
CreateItinerary     -> tripplanner-itineraries (create_itinerary)
UpdateItinerary     -> tripplanner-itineraries (update_itinerary)
CreateReservation   -> tripplanner-reservations (create_reservation)
GetReservations     -> tripplanner-reservations (get_reservations)
UpdateReservation   -> tripplanner-reservations (update_reservation)
GetUserPreferences  -> tripplanner-users (get_preferences)
SaveUserPreferences -> tripplanner-users (update_preferences)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import boto3
from botocore.config import Config
from strands import tool

import ui_events as ui

log = logging.getLogger(__name__)
REGION = os.environ.get("AWS_REGION", "us-east-2")

FUNCTIONS = {
    "trips": os.environ.get("TRIPS_FUNCTION", "tripplanner-trips"),
    "itineraries": os.environ.get("ITINERARIES_FUNCTION", "tripplanner-itineraries"),
    "reservations": os.environ.get("RESERVATIONS_FUNCTION", "tripplanner-reservations"),
    "users": os.environ.get("USERS_FUNCTION", "tripplanner-users"),
}

_lambda = boto3.client(
    "lambda", region_name=REGION, config=Config(retries={"max_attempts": 3}, read_timeout=20)
)


class ToolError(Exception):
    pass


def _invoke_sync(domain: str, action: str, params: dict) -> Any:
    user = ui.current_user.get()
    if user is None or not user.user_id:
        raise ToolError("Usuario no autenticado: inicia sesión en TripPlanner para guardar datos.")
    clean = {k: v for k, v in params.items() if v is not None and v != ""}
    payload = {"source": "agent-tool", "action": action, "userId": user.user_id, "params": clean}
    resp = _lambda.invoke(
        FunctionName=FUNCTIONS[domain],
        InvocationType="RequestResponse",
        Payload=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
    )
    body = json.loads(resp["Payload"].read() or b"{}")
    if resp.get("FunctionError"):
        log.error("Lambda %s falló: %s", FUNCTIONS[domain], body)
        raise ToolError("El servicio de datos no respondió correctamente.")
    if not body.get("ok"):
        raise ToolError(body.get("error", {}).get("message", "Operación rechazada."))
    return body["data"]


async def _invoke(domain: str, action: str, params: dict) -> Any:
    return await asyncio.to_thread(_invoke_sync, domain, action, params)


def _err(exc: Exception) -> str:
    return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)


def _ok(data: Any) -> str:
    return json.dumps({"ok": True, "data": data}, ensure_ascii=False)


# --------------------------------------------------------------------------- viajes


@tool
async def create_trip(
    destination: str,
    start_date: str,
    end_date: str,
    origin: str = "",
    travelers: int = 1,
    budget: float | None = None,
    currency: str = "COP",
    title: str = "",
    preferences: list[str] | None = None,
    notes: str = "",
) -> str:
    """CreateTrip: crea y guarda un viaje del usuario.

    Args:
        destination: ciudad de destino (p.ej. "Cartagena").
        start_date: fecha de salida YYYY-MM-DD.
        end_date: fecha de regreso YYYY-MM-DD.
        origin: ciudad de origen.
        travelers: número total de viajeros (el usuario + acompañantes).
        budget: presupuesto total del viaje.
        currency: moneda del presupuesto (COP, USD, EUR...).
        title: título corto del viaje.
        preferences: lista de preferencias del viaje (p.ej. ["playa", "gastronomía"]).
        notes: notas adicionales.
    """
    ui.status(f"Guardando el viaje a {destination}…")
    try:
        trip = await _invoke("trips", "create_trip", {
            "destination": destination, "startDate": start_date, "endDate": end_date,
            "origin": origin, "travelers": travelers, "budget": budget, "currency": currency,
            "title": title, "preferences": preferences, "notes": notes,
        })
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "trip", "trip": trip})
    ui.changed("trips")
    return _ok(trip)


@tool
async def get_trips(status: str = "") -> str:
    """GetTrips: lista los viajes guardados del usuario (opcionalmente filtrados por estado).

    Args:
        status: PLANIFICADO, CONFIRMADO, EN_CURSO, COMPLETADO o CANCELADO (vacío = todos).
    """
    ui.status("Consultando tus viajes guardados…")
    try:
        data = await _invoke("trips", "get_trips", {"status": status})
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "trips", "trips": data.get("trips", [])})
    return _ok(data)


@tool
async def get_trip_details(trip_id: str) -> str:
    """Consulta un viaje con su itinerario y sus reservas.

    Args:
        trip_id: identificador del viaje (obtenido de get_trips o create_trip).
    """
    ui.status("Recuperando el detalle del viaje…")
    try:
        data = await _invoke("trips", "get_trip", {"tripId": trip_id})
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "trip", "trip": data.get("trip")})
    if data.get("itinerary"):
        ui.ui({"type": "itinerary", "itinerary": data["itinerary"], "trip": data.get("trip")})
    if data.get("reservations"):
        ui.ui({"type": "reservations", "reservations": data["reservations"]})
    return _ok(data)


@tool
async def update_trip(
    trip_id: str,
    title: str | None = None,
    origin: str | None = None,
    destination: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    travelers: int | None = None,
    budget: float | None = None,
    currency: str | None = None,
    status: str | None = None,
    notes: str | None = None,
) -> str:
    """UpdateTrip: actualiza datos de un viaje existente. Solo envía los campos que cambian.

    Args:
        trip_id: identificador del viaje.
        status: PLANIFICADO, CONFIRMADO, EN_CURSO, COMPLETADO o CANCELADO.
        start_date: nueva fecha de salida YYYY-MM-DD.
        end_date: nueva fecha de regreso YYYY-MM-DD.
    """
    ui.status("Actualizando el viaje…")
    try:
        trip = await _invoke("trips", "update_trip", {
            "tripId": trip_id, "title": title, "origin": origin, "destination": destination,
            "startDate": start_date, "endDate": end_date, "travelers": travelers,
            "budget": budget, "currency": currency, "status": status, "notes": notes,
        })
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "trip", "trip": trip})
    ui.changed("trips")
    return _ok(trip)


# --------------------------------------------------------------------------- itinerarios

ITINERARY_DAY_HELP = (
    "Cada día: {\"day\": 1, \"title\": \"Centro histórico\", \"activities\": [{\"time\": \"09:00\", "
    "\"title\": \"...\", \"description\": \"...\", \"location\": \"...\", \"category\": "
    "\"CULTURA|PLAYA|COMIDA|NATURALEZA|AVENTURA|TOUR|COMPRAS|VIDA_NOCTURNA|DESCANSO|TRANSPORTE|HOSPEDAJE|OTRO\", "
    "\"estimatedCost\": 120000}]}"
)


@tool
async def create_itinerary(trip_id: str, days: list[dict], notes: str = "") -> str:
    """CreateItinerary: crea el itinerario (agenda por día) de un viaje.

    Args:
        trip_id: identificador del viaje.
        days: lista de días. Cada día: {"day": 1, "title": "Centro histórico", "activities":
            [{"time": "09:00", "title": "...", "description": "...", "location": "...",
            "category": "CULTURA|PLAYA|COMIDA|NATURALEZA|AVENTURA|TOUR|COMPRAS|VIDA_NOCTURNA|DESCANSO|TRANSPORTE|HOSPEDAJE|OTRO",
            "estimatedCost": 120000}]}. estimatedCost en la moneda del viaje, para todo el grupo.
        notes: recomendaciones generales (clima, presupuesto).
    """
    ui.status("Generando y guardando el itinerario…")
    try:
        itinerary = await _invoke("itineraries", "create_itinerary", {"tripId": trip_id, "days": days, "notes": notes})
    except ToolError as exc:
        if "ya tiene itinerario" in str(exc):
            try:
                itinerary = await _invoke("itineraries", "update_itinerary", {"tripId": trip_id, "days": days, "notes": notes})
            except ToolError as exc2:
                return _err(exc2)
        else:
            return _err(exc)
    ui.ui({"type": "itinerary", "itinerary": itinerary})
    ui.changed("itineraries")
    return _ok({"tripId": itinerary.get("tripId"), "days": len(itinerary.get("days", [])), "saved": True})


@tool
async def update_itinerary(
    trip_id: str,
    days: list[dict] | None = None,
    day: dict | None = None,
    notes: str | None = None,
) -> str:
    """UpdateItinerary: modifica el itinerario de un viaje.

    Envía `days` para reemplazarlo completo, o `day` para reemplazar/agregar un único día
    (mismo formato que en create_itinerary), o solo `notes`.

    Args:
        trip_id: identificador del viaje.
        days: itinerario completo (lista de días).
        day: un único día a reemplazar o agregar.
        notes: nuevas notas generales.
    """
    ui.status("Actualizando el itinerario…")
    try:
        itinerary = await _invoke("itineraries", "update_itinerary", {"tripId": trip_id, "days": days, "day": day, "notes": notes})
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "itinerary", "itinerary": itinerary})
    ui.changed("itineraries")
    return _ok({"tripId": itinerary.get("tripId"), "days": len(itinerary.get("days", [])), "saved": True})


# --------------------------------------------------------------------------- reservas


@tool
async def create_reservation(
    trip_id: str,
    type: str,
    title: str,
    date: str,
    time: str = "",
    provider: str = "",
    location: str = "",
    details: str = "",
    price: float | None = None,
    currency: str = "COP",
    quantity: int | None = None,
    end_date: str = "",
    status: str = "SIMULADA",
) -> str:
    """CreateReservation: registra una reserva SIMULADA asociada a un viaje (sin pagos).

    Args:
        trip_id: identificador del viaje.
        type: FLIGHT (vuelo), HOTEL u ACTIVITY (actividad turística).
        title: descripción corta (p.ej. "Vuelo BOG → CTG AV9821").
        date: fecha de la reserva YYYY-MM-DD (dentro de las fechas del viaje).
        time: hora HH:MM (opcional).
        provider: aerolínea, hotel u operador.
        location: lugar.
        details: detalles adicionales.
        price: precio total.
        currency: moneda del precio (USD, COP...).
        quantity: número de personas/habitaciones.
        end_date: fecha de salida del hotel YYYY-MM-DD (solo HOTEL).
        status: SIMULADA (por defecto) o PENDIENTE. Nunca CONFIRMADA.
    """
    ui.status(f"Registrando la reserva: {title}…")
    try:
        reservation = await _invoke("reservations", "create_reservation", {
            "tripId": trip_id, "type": type, "title": title, "date": date, "time": time,
            "provider": provider, "location": location, "details": details, "price": price,
            "currency": currency, "quantity": quantity, "endDate": end_date, "status": status,
        })
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "reservation", "reservation": reservation})
    ui.changed("reservations")
    return _ok(reservation)


@tool
async def get_reservations(trip_id: str = "", status: str = "", type: str = "") -> str:
    """GetReservations: consulta las reservas del usuario (filtros opcionales).

    Args:
        trip_id: solo reservas de este viaje.
        status: SIMULADA, PENDIENTE, CONFIRMADA o CANCELADA.
        type: FLIGHT, HOTEL o ACTIVITY.
    """
    ui.status("Consultando tus reservas…")
    try:
        data = await _invoke("reservations", "get_reservations", {"tripId": trip_id, "status": status, "type": type})
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "reservations", "reservations": data.get("reservations", [])})
    return _ok(data)


@tool
async def update_reservation(
    reservation_id: str,
    status: str | None = None,
    trip_id: str | None = None,
    title: str | None = None,
    date: str | None = None,
    time: str | None = None,
    provider: str | None = None,
    price: float | None = None,
    currency: str | None = None,
    details: str | None = None,
) -> str:
    """UpdateReservation: actualiza una reserva o su estado, o la asocia a otro viaje.

    Args:
        reservation_id: identificador de la reserva.
        status: SIMULADA, PENDIENTE o CANCELADA (CONFIRMADA solo la asigna un proveedor real).
        trip_id: nuevo viaje al que se asocia.
    """
    ui.status("Actualizando la reserva…")
    try:
        reservation = await _invoke("reservations", "update_reservation", {
            "reservationId": reservation_id, "status": status, "tripId": trip_id, "title": title,
            "date": date, "time": time, "provider": provider, "price": price,
            "currency": currency, "details": details,
        })
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "reservation", "reservation": reservation})
    ui.changed("reservations")
    return _ok(reservation)


# --------------------------------------------------------------------------- preferencias


@tool
async def get_user_preferences() -> str:
    """Recupera las preferencias de viaje guardadas del usuario (presupuesto, actividades, aerolíneas...)."""
    ui.status("Recuperando tus preferencias…")
    try:
        prefs = await _invoke("users", "get_preferences", {})
    except ToolError as exc:
        return _err(exc)
    return _ok(prefs)


@tool
async def save_user_preferences(
    activity_types: list[str] | None = None,
    budget_level: str | None = None,
    preferred_airlines: list[str] | None = None,
    dietary_restrictions: list[str] | None = None,
    seat: str | None = None,
    preferred_departure_time: str | None = None,
    home_city: str | None = None,
    notes: str | None = None,
) -> str:
    """Guarda (fusiona) preferencias persistentes de viaje del usuario.

    Args:
        activity_types: tipos de actividad preferidos (p.ej. ["playa", "museos"]).
        budget_level: ECONOMICO, MEDIO, ALTO o LUJO.
        preferred_airlines: aerolíneas preferidas.
        dietary_restrictions: restricciones alimentarias.
        seat: VENTANA, PASILLO o INDIFERENTE.
        preferred_departure_time: MANANA, TARDE, NOCHE o INDIFERENTE.
        home_city: ciudad de residencia.
        notes: otras preferencias.
    """
    ui.status("Guardando tus preferencias…")
    try:
        prefs = await _invoke("users", "update_preferences", {
            "activityTypes": activity_types, "budgetLevel": budget_level,
            "preferredAirlines": preferred_airlines, "dietaryRestrictions": dietary_restrictions,
            "seat": seat, "preferredDepartureTime": preferred_departure_time,
            "homeCity": home_city, "notes": notes,
        })
    except ToolError as exc:
        return _err(exc)
    ui.ui({"type": "preferences", "preferences": prefs})
    ui.changed("preferences")
    return _ok(prefs)


BUSINESS_TOOLS = [
    create_trip,
    get_trips,
    get_trip_details,
    update_trip,
    create_itinerary,
    update_itinerary,
    create_reservation,
    get_reservations,
    update_reservation,
    get_user_preferences,
    save_user_preferences,
]
