"""Lambda de usuarios y preferencias (perfil + gustos/restricciones de viaje)."""

from common import (
    CURRENCIES,
    get_item,
    make_handler,
    now_iso,
    req_enum,
    req_int,
    req_money,
    req_str,
    str_list,
    strip_keys,
    table,
    user_pk,
)

BUDGET_LEVELS = {"ECONOMICO", "MEDIO", "ALTO", "LUJO"}
SEATS = {"VENTANA", "PASILLO", "INDIFERENTE"}
TIMES = {"MANANA", "TARDE", "NOCHE", "INDIFERENTE"}


def _ensure_profile(user_id: str, claims: dict) -> dict:
    profile = get_item(user_id, "PROFILE")
    if profile is None:
        profile = {
            "PK": user_pk(user_id),
            "SK": "PROFILE",
            "entityType": "USER",
            "userId": user_id,
            "email": claims.get("email") or "",
            "name": claims.get("name") or (claims.get("email") or "Viajero").split("@")[0],
            "createdAt": now_iso(),
        }
        table().put_item(Item=profile)
    elif not profile.get("email") and claims.get("email"):
        # Perfil creado con un access token (sin email): se completa con el ID token.
        profile["email"] = claims["email"]
        if claims.get("name"):
            profile["name"] = claims["name"]
        table().put_item(Item=profile)
    return profile


def get_profile(user_id: str, params: dict, claims: dict) -> dict:
    profile = _ensure_profile(user_id, claims)
    prefs = get_item(user_id, "PREFS")
    return {"profile": strip_keys(profile), "preferences": strip_keys(prefs) or {}}


def update_profile(user_id: str, params: dict, claims: dict) -> dict:
    _ensure_profile(user_id, claims)
    name = req_str(params, "name", 80)
    home_city = req_str(params, "homeCity", 80, required=False)
    expr = "SET #n = :n, updatedAt = :u"
    values = {":n": name, ":u": now_iso()}
    if home_city:
        expr += ", homeCity = :h"
        values[":h"] = home_city
    resp = table().update_item(
        Key={"PK": user_pk(user_id), "SK": "PROFILE"},
        UpdateExpression=expr,
        ExpressionAttributeNames={"#n": "name"},
        ExpressionAttributeValues=values,
        ReturnValues="ALL_NEW",
    )
    return strip_keys(resp["Attributes"])


def get_preferences(user_id: str, params: dict, claims: dict) -> dict:
    return strip_keys(get_item(user_id, "PREFS")) or {}


def update_preferences(user_id: str, params: dict, claims: dict) -> dict:
    _ensure_profile(user_id, claims)
    current = get_item(user_id, "PREFS") or {}
    prefs = {
        "budgetLevel": req_enum(params, "budgetLevel", BUDGET_LEVELS, required=False),
        "dailyBudget": req_money(params, "dailyBudget"),
        "currency": req_enum(params, "currency", CURRENCIES, required=False),
        "activityTypes": str_list(params, "activityTypes"),
        "dietaryRestrictions": str_list(params, "dietaryRestrictions"),
        "preferredAirlines": str_list(params, "preferredAirlines", 10),
        "seat": req_enum(params, "seat", SEATS, required=False),
        "preferredDepartureTime": req_enum(params, "preferredDepartureTime", TIMES, required=False),
        "homeCity": req_str(params, "homeCity", 80, required=False),
        "travelersDefault": req_int(params, "travelersDefault", 1, 20, required=False),
        "notes": req_str(params, "notes", 500, required=False),
    }
    merged = {k: v for k, v in current.items() if k not in ("PK", "SK")}
    merged.update({k: v for k, v in prefs.items() if v is not None})
    merged.pop("updatedAt", None)
    merged.pop("entityType", None)
    item = {
        "PK": user_pk(user_id),
        "SK": "PREFS",
        "entityType": "PREFERENCES",
        **merged,
        "updatedAt": now_iso(),
    }
    table().put_item(Item=item)
    return strip_keys(item)


ACTIONS = {
    "get_profile": get_profile,
    "update_profile": update_profile,
    "get_preferences": get_preferences,
    "update_preferences": update_preferences,
}

ROUTES = {
    "GET /me": "get_profile",
    "PUT /me": "update_profile",
    "GET /preferences": "get_preferences",
    "PUT /preferences": "update_preferences",
}

handler = make_handler(ACTIONS, ROUTES)
