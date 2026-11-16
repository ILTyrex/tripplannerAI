"""Devuelve la salida de la herramienta de clima tal cual (JSON) como respuesta final del agente.

Mismo patrón que FlightResponseAgent: el LLM decide ciudad/fechas y llama a la herramienta,
pero el texto final es el resultado autoritativo del MCP para evitar que el modelo lo altere.
"""

from collections.abc import AsyncIterator
from typing import Any

from strands import Agent


async def final_response_stream(events: AsyncIterator[Any], state: dict) -> AsyncIterator[Any]:
    state["response"] = None
    async for event in events:
        if "result" in event and state["response"] is not None:
            event["result"].message = {"role": "assistant", "content": [{"text": state["response"]}]}
        yield event


class WeatherResponseAgent(Agent):
    def __init__(self, *args: Any, search_state: dict, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._state = search_state

    async def stream_async(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        async for event in final_response_stream(super().stream_async(*args, **kwargs), self._state):
            yield event
