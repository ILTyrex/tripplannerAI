# app/WeatherAgent/main.py
"""Weather Agent (A2A) de TripPlanner.

Especialista en clima. Consume el MCP de clima (`weather_mcp_server.py`, servidor MCP stdio
sobre Open-Meteo) mediante el cliente MCP de Strands. Devuelve al Orchestrator el JSON
estructurado de la herramienta para que el frontend lo renderice como tarjetas (Agent-Driven UI).
"""

import hashlib
import json
import logging
import os
import sys
import threading
import time
from datetime import date
from pathlib import Path
from urllib.parse import quote
from uuid import uuid4

from mcp import StdioServerParameters, stdio_client
from strands import Agent, tool
from strands.models import BedrockModel
from strands.multiagent.a2a import A2AServer
from strands.tools.mcp import MCPClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from weather_response import WeatherResponseAgent  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

REGION = os.environ.get("AWS_REGION", "us-east-2")
MODEL_ID = os.environ.get("WEATHER_MODEL_ID", "us.amazon.nova-lite-v1:0")
MCP_SERVER = Path(__file__).with_name("weather_mcp_server.py")

_weather_mcp: MCPClient | None = None
_mcp_lock = threading.Lock()


def get_weather_mcp() -> MCPClient:
    """Sesión MCP (stdio) abierta una sola vez y reutilizada durante la vida del proceso."""
    global _weather_mcp
    with _mcp_lock:
        return _start_mcp() if _weather_mcp is None else _weather_mcp


def _start_mcp() -> MCPClient:
    global _weather_mcp
    if _weather_mcp is None:
        client = MCPClient(
            lambda: stdio_client(
                StdioServerParameters(
                    command=sys.executable,
                    args=[str(MCP_SERVER)],
                    env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)},
                )
            )
        )
        client.start()
        tools = {t.tool_name for t in client.list_tools_sync()}
        if "get_weather_forecast" not in tools:
            raise RuntimeError(f"El MCP de clima no expone get_weather_forecast (tools: {tools})")
        _weather_mcp = client
    return _weather_mcp


def build_system_prompt() -> str:
    return (
        f"Hoy es {date.today().isoformat()}. "
        "Eres un agente de clima. Para cada solicitud, identifica la ciudad y la fecha "
        "(o el rango de fechas) y llama siempre a get_weather_forecast con city, start_date y "
        "end_date en formato YYYY-MM-DD. Si solo hay una fecha, usa la misma como end_date. "
        "No respondas según conocimiento general ni inventes datos. La herramienta devuelve el "
        "resultado final; cópialo exactamente, sin agregar texto. Si no puedes identificar "
        "la ciudad o la fecha, pide únicamente el dato que falta."
    )


@tool
def get_forecast(city: str, date: str) -> dict:
    """Pronóstico simulado y estable (respaldo si el MCP de clima no responde)."""
    forecasts = [
        ("Soleado", 29),
        ("Parcialmente nublado", 24),
        ("Nublado", 19),
        ("Lluvia ligera", 16),
        ("Lluvioso", 14),
        ("Tormentas aisladas", 22),
        ("Ventoso", 18),
    ]
    seed = hashlib.sha256(f"{city.casefold()}:{date}".encode("utf-8")).digest()
    condition, temperature = forecasts[int.from_bytes(seed[:2], "big") % len(forecasts)]
    return {"city": city, "date": date, "temp_c": temperature, "condition": condition}


def create_agent(context_id: str) -> Agent:
    state: dict[str, str | None] = {"response": None}

    @tool
    def get_weather_forecast(city: str, start_date: str, end_date: str = "") -> str:
        """Consulta el MCP de clima: temperatura, condición y probabilidad de lluvia por día.

        Args:
            city: ciudad (opcionalmente con país, p.ej. "Cartagena, Colombia").
            start_date: fecha inicial YYYY-MM-DD.
            end_date: fecha final YYYY-MM-DD (igual a start_date si es un solo día).
        """
        started = time.perf_counter()
        args = {"city": city, "start_date": start_date}
        if end_date:
            args["end_date"] = end_date
        try:
            result = get_weather_mcp().call_tool_sync(uuid4().hex, "get_weather_forecast", args)
            if result["status"] != "success":
                raise RuntimeError(f"MCP de clima falló: {result}")
            text = "".join(
                b["text"] for b in result["content"] if isinstance(b, dict) and isinstance(b.get("text"), str)
            )
            json.loads(text)  # valida que sea JSON
            response = text
            logger.info("MCP clima ok en %.0f ms (%s %s..%s)", (time.perf_counter() - started) * 1000, city, start_date, end_date)
        except Exception:
            logger.exception("MCP de clima falló (%s %s..%s)", city, start_date, end_date)
            response = json.dumps(
                {"city": city, "startDate": start_date, "endDate": end_date or start_date,
                 "error": "No se pudo consultar el clima en este momento.", "days": []},
                ensure_ascii=False,
            )
        state["response"] = response
        return response

    return WeatherResponseAgent(
        name="Weather Agent",
        description="Consulta el pronóstico del clima (temperatura, condición, lluvia) por ciudad y fechas vía MCP.",
        model=BedrockModel(model_id=MODEL_ID, region_name=REGION),
        system_prompt=build_system_prompt(),
        tools=[get_weather_forecast],
        callback_handler=None,
        search_state=state,
    )


RUNTIME_ARN = os.environ.get(
    "WEATHER_RUNTIME_ARN",
    "arn:aws:bedrock-agentcore:us-east-2:289076681196:runtime/tripplaner_WeatherAgent-aJJvVI7ABv",
)
DEFAULT_URL = (
    f"https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/"
    f"{quote(RUNTIME_ARN, safe='')}/invocations/"
)
# URL pública que va en la agent card: sin esto el cliente intenta conectarse a 0.0.0.0:9000
runtime_url = os.environ.get("AGENTCORE_RUNTIME_URL", DEFAULT_URL)

a2a_server = A2AServer(
    agent_factory=create_agent,
    http_url=runtime_url,
    serve_at_root=True,
    host="0.0.0.0",
    port=9000,
)

def build_app():
    """App A2A de Strands + GET /ping (health check que exige AgentCore Runtime)."""
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    app = a2a_server.to_starlette_app()
    app.router.routes.insert(0, Route("/ping", lambda request: JSONResponse({"status": "Healthy"}), methods=["GET"]))
    return app


def _warm_mcp() -> None:
    try:
        get_weather_mcp()
        logger.info("MCP de clima precalentado")
    except Exception:
        logger.exception("No se pudo precalentar el MCP de clima (se reintentará en la primera consulta)")


if __name__ == "__main__":
    import uvicorn

    threading.Thread(target=_warm_mcp, daemon=True).start()
    uvicorn.run(build_app(), host="0.0.0.0", port=9000)
