import json
import unittest
from unittest.mock import MagicMock, patch

from app.WeatherAgent import main as weather
from app.WeatherAgent import weather_mcp_server as mcp_server


class WeatherAgentTests(unittest.TestCase):
    @patch("app.WeatherAgent.main.WeatherResponseAgent")
    @patch("app.WeatherAgent.main.BedrockModel")
    def test_agent_is_instructed_to_call_mcp_forecast_tool(self, bedrock_model, agent_class):
        weather.create_agent("test-context")

        agent_class.assert_called_once()
        kwargs = agent_class.call_args.kwargs
        self.assertIn("llama siempre a get_weather_forecast", kwargs["system_prompt"])
        self.assertEqual([t.tool_name for t in kwargs["tools"]], ["get_weather_forecast"])
        bedrock_model.assert_called_once_with(model_id="us.amazon.nova-lite-v1:0", region_name="us-east-2")

    @patch("app.WeatherAgent.main.get_weather_mcp")
    @patch("app.WeatherAgent.main.WeatherResponseAgent")
    @patch("app.WeatherAgent.main.BedrockModel")
    def test_tool_returns_mcp_json_and_records_it(self, _model, agent_class, get_mcp):
        payload = {"city": "Cartagena", "days": [{"date": "2026-12-10", "condition": "Despejado"}]}
        get_mcp.return_value.call_tool_sync.return_value = {
            "status": "success",
            "content": [{"text": json.dumps(payload)}],
        }
        weather.create_agent("ctx")
        tool = agent_class.call_args.kwargs["tools"][0]
        state = agent_class.call_args.kwargs["search_state"]

        result = tool._tool_func("Cartagena", "2026-12-10", "2026-12-10")

        self.assertEqual(json.loads(result), payload)
        self.assertEqual(state["response"], result)

    @patch("app.WeatherAgent.main.get_weather_mcp")
    @patch("app.WeatherAgent.main.WeatherResponseAgent")
    @patch("app.WeatherAgent.main.BedrockModel")
    def test_tool_returns_error_json_when_mcp_fails(self, _model, agent_class, get_mcp):
        get_mcp.return_value.call_tool_sync.side_effect = RuntimeError("down")
        weather.create_agent("ctx")
        tool = agent_class.call_args.kwargs["tools"][0]

        result = json.loads(tool._tool_func("Cartagena", "2026-12-10"))

        self.assertEqual(result["days"], [])
        self.assertIn("error", result)

    def test_fallback_forecast_is_deterministic(self):
        first = weather.get_forecast._tool_func("Madrid", "2026-10-24")
        self.assertEqual(first, weather.get_forecast._tool_func("Madrid", "2026-10-24"))
        self.assertIsInstance(first["temp_c"], int)


class WeatherMcpServerTests(unittest.TestCase):
    def test_wmo_codes_map_to_spanish_conditions(self):
        self.assertEqual(mcp_server._condition(0), ("Despejado", "sun"))
        self.assertEqual(mcp_server._condition(63)[0], "Lluvia moderada")
        self.assertEqual(mcp_server._condition(None)[0], "Desconocido")

    def test_rows_include_rain_probability(self):
        rows = mcp_server._rows({
            "time": ["2026-12-10"],
            "weather_code": [2],
            "temperature_2m_max": [31.5],
            "temperature_2m_min": [25.1],
            "precipitation_sum": [0.4],
            "precipitation_probability_max": [35],
        })
        self.assertEqual(rows[0]["rainProbability"], 35)
        self.assertEqual(rows[0]["condition"], "Parcialmente nublado")

    def test_geocode_prefers_colombia(self):
        client = MagicMock()
        client.get.return_value.json.return_value = {"results": [
            {"name": "Cartagena", "country": "España", "country_code": "ES", "population": 200000},
            {"name": "Cartagena de Indias", "country": "Colombia", "country_code": "CO", "population": 900000},
        ]}
        self.assertEqual(mcp_server._geocode(client, "Cartagena")["country_code"], "CO")
        self.assertEqual(mcp_server._geocode(client, "Cartagena, España")["country_code"], "ES")


if __name__ == "__main__":
    unittest.main()
