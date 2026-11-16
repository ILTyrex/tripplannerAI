// Canal 2 · Interacción agéntica: Frontend -> HTTP streaming (SSE) -> Amazon Bedrock AgentCore
// -> Orchestrator Agent. Se consume DIRECTO (sin API Gateway) con el JWT de Cognito, que
// AgentCore valida con su autorizador CUSTOM_JWT.
import { getAccessToken } from "./auth.js";

const cfg = window.TRIPPLANNER_CONFIG;

export function newSessionId() {
  // AgentCore exige un session id de al menos 33 caracteres.
  const uuid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `tp-${uuid}`;
}

function endpoint() {
  return `https://bedrock-agentcore.${cfg.region}.amazonaws.com/runtimes/${encodeURIComponent(cfg.agentRuntimeArn)}/invocations?qualifier=DEFAULT`;
}

/**
 * Envía un mensaje al Orchestrator y procesa el stream de eventos.
 * @param {string} prompt
 * @param {string} sessionId
 * @param {(event: object) => void} onEvent  status | tool | text | ui | data_changed | error | done
 * @param {AbortSignal} [signal]
 */
export async function streamChat(prompt, sessionId, onEvent, signal) {
  const token = await getAccessToken();
  if (!token) throw new Error("Tu sesión expiró. Inicia sesión de nuevo.");
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
    },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new Error("No autorizado para usar el asistente. Inicia sesión de nuevo.");
    if (res.status === 429) throw new Error("El asistente está ocupado. Intenta en unos segundos.");
    console.error("AgentCore error", res.status, text);
    throw new Error("El asistente no está disponible en este momento.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const handleLine = (line) => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw) return;
    let event;
    try { event = JSON.parse(raw); } catch { event = { type: "text", text: raw }; }
    if (typeof event === "string") event = { type: "text", text: event };
    if (event && event.type) {
      if (event.type === "done") finished = true;
      onEvent(event);
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, index).replace(/\r$/, ""));
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) handleLine(buffer);
  if (!finished) onEvent({ type: "done" });
}
