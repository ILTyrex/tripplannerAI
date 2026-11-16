"""MCP de clima de TripPlanner (servidor MCP sobre stdio).

Expone la herramienta `get_weather_forecast` usando Open-Meteo (gratuito y sin API key):
- Geocodificación de la ciudad (geocoding-api.open-meteo.com).
- Pronóstico diario hasta 16 días (api.open-meteo.com): temperatura máx/mín,
  condición y probabilidad de lluvia.
- Para fechas fuera del horizonte de pronóstico usa el histórico del mismo periodo del
  año anterior (archive-api.open-meteo.com) y lo marca como "historico".

El Weather Agent lo lanza como subproceso y lo consume con el cliente MCP de Strands.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

import httpx
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("tripplanner-weather")

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_HORIZON_DAYS = 15
MAX_RANGE_DAYS = 16

# Códigos WMO -> (condición en español, icono)
WMO = {
    0: ("Despejado", "sun"),
    1: ("Mayormente despejado", "sun"),
    2: ("Parcialmente nublado", "cloud-sun"),
    3: ("Nublado", "cloud"),
    45: ("Niebla", "fog"),
    48: ("Niebla con escarcha", "fog"),
    51: ("Llovizna ligera", "drizzle"),
    53: ("Llovizna", "drizzle"),
    55: ("Llovizna intensa", "drizzle"),
    56: ("Llovizna helada", "drizzle"),
    57: ("Llovizna helada intensa", "drizzle"),
    61: ("Lluvia ligera", "rain"),
    63: ("Lluvia moderada", "rain"),
    65: ("Lluvia fuerte", "rain"),
    66: ("Lluvia helada", "rain"),
    67: ("Lluvia helada fuerte", "rain"),
    71: ("Nevada ligera", "snow"),
    73: ("Nevada", "snow"),
    75: ("Nevada fuerte", "snow"),
    77: ("Granizo fino", "snow"),
    80: ("Chubascos ligeros", "rain"),
    81: ("Chubascos", "rain"),
    82: ("Chubascos fuertes", "rain"),
    85: ("Chubascos de nieve", "snow"),
    86: ("Chubascos de nieve fuertes", "snow"),
    95: ("Tormenta eléctrica", "storm"),
    96: ("Tormenta con granizo", "storm"),
    99: ("Tormenta fuerte con granizo", "storm"),
}


def _condition(code) -> tuple[str, str]:
    try:
        return WMO.get(int(code), ("Desconocido", "cloud"))
    except (TypeError, ValueError):
        return ("Desconocido", "cloud")


def _geocode(client: httpx.Client, city: str) -> dict:
    name = city.split(",")[0].strip()
    resp = client.get(GEOCODING_URL, params={"name": name, "count": 5, "language": "es", "format": "json"})
    resp.raise_for_status()
    results = resp.json().get("results") or []
    if not results:
        raise ValueError(f"No se encontró la ciudad '{city}'.")
    hint = city.casefold()
    # Prioriza coincidencia de país si el usuario lo indicó (p.ej. "Cartagena, Colombia").
    for result in results:
        if result.get("country", "").casefold() in hint:
            return result
    # Por defecto prioriza Colombia (público objetivo) y luego la de mayor población.
    colombia = [r for r in results if r.get("country_code") == "CO"]
    pool = colombia or results
    return max(pool, key=lambda r: r.get("population") or 0)


def _daily(client: httpx.Client, url: str, lat: float, lon: float, start: date, end: date, with_prob: bool) -> dict:
    daily = ["weather_code", "temperature_2m_max", "temperature_2m_min", "precipitation_sum"]
    if with_prob:
        daily.append("precipitation_probability_max")
    resp = client.get(
        url,
        params={
            "latitude": lat,
            "longitude": lon,
            "daily": ",".join(daily),
            "timezone": "auto",
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
        },
    )
    resp.raise_for_status()
    return resp.json().get("daily") or {}


def _rows(daily: dict, shift_years: int = 0) -> list[dict]:
    rows = []
    times = daily.get("time") or []
    for i, day in enumerate(times):
        condition, icon = _condition((daily.get("weather_code") or [None])[i])
        prob = daily.get("precipitation_probability_max")
        rain_mm = (daily.get("precipitation_sum") or [None] * len(times))[i]
        d = date.fromisoformat(day)
        if shift_years:
            d = d.replace(year=d.year + shift_years)
        rows.append(
            {
                "date": d.isoformat(),
                "condition": condition,
                "icon": icon,
                "tempMax": (daily.get("temperature_2m_max") or [None])[i],
                "tempMin": (daily.get("temperature_2m_min") or [None])[i],
                "rainProbability": prob[i] if prob else None,
                "precipitationMm": rain_mm,
            }
        )
    return rows


@mcp.tool()
def get_weather_forecast(city: str, start_date: str, end_date: str | None = None) -> str:
    """Pronóstico del clima por ciudad y rango de fechas (YYYY-MM-DD).

    Devuelve JSON con temperatura máxima/mínima (°C), condición, probabilidad de lluvia (%)
    y precipitación (mm) por día. Máximo 16 días por consulta.
    """
    start = date.fromisoformat(start_date)
    end = date.fromisoformat(end_date) if end_date else start
    if end < start:
        start, end = end, start
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        end = start + timedelta(days=MAX_RANGE_DAYS - 1)

    today = date.today()
    horizon = today + timedelta(days=FORECAST_HORIZON_DAYS)
    with httpx.Client(timeout=15.0) as client:
        place = _geocode(client, city)
        lat, lon = place["latitude"], place["longitude"]
        days: list[dict] = []
        source = "pronostico"

        # Parte dentro del horizonte de pronóstico.
        f_start, f_end = max(start, today - timedelta(days=1)), min(end, horizon)
        if f_start <= f_end:
            days += _rows(_daily(client, FORECAST_URL, lat, lon, f_start, f_end, True))

        # Parte fuera del horizonte (o pasada): histórico del año anterior.
        missing = [
            start + timedelta(days=i)
            for i in range((end - start).days + 1)
            if (start + timedelta(days=i)).isoformat() not in {d["date"] for d in days}
        ]
        if missing:
            h_start = min(missing).replace(year=min(missing).year - 1)
            h_end = max(missing).replace(year=max(missing).year - 1)
            hist = _rows(_daily(client, ARCHIVE_URL, lat, lon, h_start, h_end, False), shift_years=1)
            for row in hist:
                row["estimated"] = True
            days += [r for r in hist if r["date"] in {m.isoformat() for m in missing}]
            source = "historico" if not (f_start <= f_end) else "mixto"

    days.sort(key=lambda d: d["date"])
    return json.dumps(
        {
            "city": place.get("name", city),
            "country": place.get("country", ""),
            "latitude": lat,
            "longitude": lon,
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "source": source,
            "sourceNote": (
                "Pronóstico Open-Meteo"
                if source == "pronostico"
                else "Fechas fuera del horizonte de pronóstico: se usa el clima observado del mismo periodo del año anterior como estimación."
            ),
            "days": days,
        },
        ensure_ascii=False,
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")
