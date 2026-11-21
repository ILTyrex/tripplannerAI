import { signIn, signUp, signOut, currentUser, getAccessToken } from "./auth.js";
import { api } from "./api.js";
import { streamChat, newSessionId } from "./agent.js";
import { icon, hydrateIcons } from "./icons.js";
import {
  esc, attr, badge, money, fmtDate, fmtRange, tripDays, daysUntil, markdown, renderBlock,
  flightsBlock, weatherBlock, tripCard, itineraryBlock, reservationsBlock, preferencesSummary, RES_TYPES,
} from "./components.js";
import { exportTripPdf } from "./pdf.js";

const cfg = window.TRIPPLANNER_CONFIG;
const $ = (sel, root = document) => root.querySelector(sel);
const view = $("#view");

const state = {
  user: null,
  trips: null,
  reservations: null,
  preferences: null,
  chat: null,
  busy: false,
  toolSession: newSessionId(),
};

// ------------------------------------------------------------------ utilidades UI
function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toast-root").append(el);
  setTimeout(() => el.remove(), 4200);
}

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

function weatherCache(block) {
  const key = `tp.weather.${state.user?.sub}`;
  const cache = store(key) || {};
  if (block) {
    if (!block.city || !block.days?.length) return;
    cache[block.city.toLowerCase()] = { ...block, savedAt: Date.now() };
    store(key, cache);
    return;
  }
  return cache;
}
function weatherFor(destination) {
  const cache = weatherCache() || {};
  const d = (destination || "").toLowerCase();
  return Object.values(cache).find((b) => b.city.toLowerCase().includes(d) || d.includes(b.city.toLowerCase().split(" ")[0])) || null;
}

function modal(html, { onMount } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="card modal" role="dialog" aria-modal="true">${html}</div></div>`;
  hydrateIcons(root);
  const close = () => { root.innerHTML = ""; };
  root.querySelector(".modal-backdrop").addEventListener("mousedown", (e) => { if (e.target.classList.contains("modal-backdrop")) close(); });
  root.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  onMount?.(root.querySelector(".modal"), close);
  root.querySelector("input,select,textarea")?.focus();
  return close;
}

function formData(form) {
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = typeof v === "string" ? v.trim() : v; });
  return data;
}

function setLoading(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span> Procesando…`; }
  else if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
}

function render(html) {
  view.innerHTML = html;
  hydrateIcons(view);
  view.focus({ preventScroll: true });
}

async function loadTrips(force = false) {
  if (!state.trips || force) state.trips = (await api.trips()).trips;
  return state.trips;
}
async function loadReservations(force = false) {
  if (!state.reservations || force) state.reservations = (await api.reservations()).reservations;
  return state.reservations;
}
function invalidate(entity) {
  if (!entity || entity === "trips" || entity === "itineraries") state.trips = null;
  if (!entity || entity === "reservations" || entity === "trips") state.reservations = null;
  if (!entity || entity === "preferences") state.preferences = null;
}

// ------------------------------------------------------------------ autenticación
function showAuth() {
  $("#app").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  hydrateIcons($("#auth-screen"));
}

function initAuthScreen() {
  document.querySelectorAll("[data-auth-tab]").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll("[data-auth-tab]").forEach((t) => t.classList.toggle("active", t === tab));
    $("#login-form").classList.toggle("hidden", tab.dataset.authTab !== "login");
    $("#register-form").classList.toggle("hidden", tab.dataset.authTab !== "register");
    $("#auth-error").textContent = "";
  }));
  const handle = (form, fn) => form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    setLoading(btn, true);
    $("#auth-error").textContent = "";
    try {
      await fn(formData(form));
      form.reset();
      await startApp();
    } catch (err) {
      $("#auth-error").textContent = err.message;
    } finally {
      setLoading(btn, false);
    }
  });
  handle($("#login-form"), (d) => signIn(d.email, d.password));
  handle($("#register-form"), (d) => signUp(d.name, d.email, d.password));
}

async function startApp() {
  const token = await getAccessToken();
  if (!token) return showAuth();
  state.user = currentUser();
  state.chat = store(`tp.chat.${state.user.sub}`) || { sessionId: newSessionId(), messages: [] };
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  hydrateIcons($("#app"));
  $("#user-name").textContent = state.user.name || "Viajero";
  $("#user-email").textContent = state.user.email || "";
  $("#user-avatar").textContent = (state.user.name || "?").slice(0, 1).toUpperCase();
  api.me().then((d) => { state.preferences = d.preferences; if (d.profile?.name) $("#user-name").textContent = d.profile.name; }).catch(() => {});
  if (!location.hash || location.hash === "#/") location.hash = "#/dashboard";
  else route();
}

$("#logout-btn").addEventListener("click", () => {
  signOut();
  Object.assign(state, { user: null, trips: null, reservations: null, preferences: null, chat: null });
  location.hash = "";
  showAuth();
});

// ------------------------------------------------------------------ router
const routes = {
  dashboard: renderDashboard,
  asistente: renderChat,
  vuelos: renderFlights,
  clima: renderWeather,
  viajes: renderTrips,
  reservas: renderReservations,
  preferencias: renderPreferences,
};

async function route() {
  if (!state.user) return;
  const [name, param] = location.hash.replace(/^#\//, "").split("/");
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
  const fn = name === "viajes" && param ? () => renderTripDetail(decodeURIComponent(param)) : routes[name] || renderDashboard;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    if (err.status === 401) { signOut(); return showAuth(); }
    render(`<div class="card empty"><div class="big-icon">${icon("info")}</div><p>${esc(err.message || "Error cargando la vista.")}</p>
      <button class="btn btn-primary" onclick="location.reload()">Reintentar</button></div>`);
  }
}
window.addEventListener("hashchange", route);

function skeleton(title) {
  render(`<div class="page-head"><div><h1>${esc(title)}</h1></div></div><div class="card"><div class="status-line"><span class="spinner"></span> Cargando…</div></div>`);
}

// ------------------------------------------------------------------ 1. Dashboard
const DEMO_PROMPT = "Quiero organizar unas vacaciones de cuatro días en Cartagena. Salgo desde Bogotá, viajo con dos personas más y tengo un presupuesto de 5 millones de pesos. Quiero conocer el clima, encontrar vuelos y organizar algunas actividades turísticas.";

async function renderDashboard() {
  skeleton("Dashboard");
  const [trips, reservations] = await Promise.all([loadTrips(), loadReservations()]);
  const upcoming = trips.filter((t) => t.status !== "CANCELADO" && (daysUntil(t.endDate) ?? 0) >= 0).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const next = upcoming[0];
  const active = reservations.filter((r) => r.status !== "CANCELADA");
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Buenos días" : hour < 19 ? "Buenas tardes" : "Buenas noches";
  render(`
    <div class="page-head"><div><h1>${hello}, ${esc(state.user.name || "viajero")} 👋</h1><p>Este es el resumen de tus viajes.</p></div>
      <a class="btn btn-primary" href="#/asistente" data-action="demo">${icon("sparkles")} Planificar con IA</a></div>
    <div class="grid grid-4" style="margin-bottom:16px">
      <div class="card stat"><span>Próximos viajes</span><b>${upcoming.length}</b></div>
      <div class="card stat"><span>Reservas activas</span><b>${active.length}</b></div>
      <div class="card stat"><span>Próxima salida</span><b>${next ? (daysUntil(next.startDate) > 0 ? `${daysUntil(next.startDate)} días` : "En curso") : "—"}</b></div>
      <div class="card stat"><span>Viajes guardados</span><b>${trips.length}</b></div>
    </div>
    <div class="grid grid-3" style="grid-template-columns:2fr 1fr;align-items:start">
      <div class="stack">
        <div class="card"><div class="card-title"><h2>Próximos viajes</h2><a href="#/viajes" class="btn btn-sm btn-ghost">Ver todos</a></div>
          ${upcoming.length ? `<div class="cards-auto">${upcoming.slice(0, 4).map(tripCard).join("")}</div>`
            : `<div class="empty"><div class="big-icon">${icon("map")}</div><p>Aún no tienes viajes próximos.</p><button class="btn btn-primary" data-action="demo">${icon("sparkles")} Probar el escenario de demostración</button></div>`}
        </div>
        <div class="card"><div class="card-title"><h2>Reservas recientes</h2><a href="#/reservas" class="btn btn-sm btn-ghost">Gestionar</a></div>
          ${reservationsBlock(reservations.slice(0, 5), { actions: false })}</div>
      </div>
      <div class="stack">
        <div class="card"><h2>Accesos rápidos</h2><div class="stack" style="gap:8px;margin-top:10px">
          <a class="btn btn-ghost" href="#/asistente">${icon("sparkles")} Hablar con el asistente</a>
          <a class="btn btn-ghost" href="#/vuelos">${icon("plane")} Buscar vuelos</a>
          <a class="btn btn-ghost" href="#/clima">${icon("sun")} Consultar clima</a>
          <button class="btn btn-ghost" data-action="new-trip">${icon("plus")} Nuevo viaje</button>
          <button class="btn btn-ghost" data-action="new-reservation">${icon("ticket")} Nueva reserva</button>
        </div></div>
        <div class="card"><h3>${icon("bot")} Arquitectura multiagente</h3>
          <p class="muted" style="font-size:.88rem">El <b>Orchestrator</b> interpreta tu solicitud y delega en el <b>Flight Agent</b> (MCP de vuelos) y el <b>Weather Agent</b> (MCP de clima). Las Tools de negocio guardan viajes, itinerarios y reservas en DynamoDB a través de Lambda.</p></div>
      </div>
    </div>`);
}

// ------------------------------------------------------------------ 2. Asistente conversacional
const SUGGESTIONS = [
  DEMO_PROMPT,
  "Crea el viaje con ese plan y genera el itinerario",
  "Reserva el vuelo de ida más barato (simulado)",
  "¿Qué viajes y reservas tengo guardados?",
  "¿Cómo estará el clima en Medellín este fin de semana?",
];

function saveChat() {
  state.chat.messages = state.chat.messages.slice(-40);
  store(`tp.chat.${state.user.sub}`, state.chat);
}

function messageHtml(m, i) {
  if (m.role === "user") return `<div class="msg user"><div class="bubble">${esc(m.text)}</div></div>`;
  return `<div class="msg assistant" data-msg="${i}"><span class="avatar">${icon("bot")}</span><div class="bubble">
      <div class="agents">${m.agents?.length ? m.agents.map((a) => `<span class="agent-pill">${esc(a)}</span>`).join("") : ""}</div>
      <div class="md">${markdown(m.text)}</div>
      ${m.error ? `<p class="form-error">${esc(m.error)}</p>` : ""}
      <div class="blocks">${(m.blocks || []).map(renderBlock).join("")}</div></div></div>`;
}

function renderChat(prefill) {
  if (!cfg.agentRuntimeArn) {
    return render(`<div class="card empty"><p>El asistente aún no está configurado (falta el ARN del Orchestrator en config.js).</p></div>`);
  }
  const msgs = state.chat.messages;
  render(`<div class="chat">
    <div class="page-head" style="margin:0"><div><h1>Asistente</h1><p>Orchestrator Agent · HTTP streaming con Amazon Bedrock AgentCore</p></div>
      <button class="btn btn-ghost btn-sm" data-action="new-chat">${icon("refresh")} Nueva conversación</button></div>
    <div class="chat-log" id="chat-log">
      ${msgs.length ? msgs.map(messageHtml).join("") : `<div class="card empty" style="margin:auto;max-width:640px">
        <div class="big-icon">${icon("sparkles")}</div><h2>¿A dónde quieres ir?</h2>
        <p>Pídeme vuelos, clima, planificar unas vacaciones, crear el itinerario o registrar reservas.</p>
        <div class="chips" style="justify-content:center;margin-top:12px">${SUGGESTIONS.map((s) => `<button class="chip" data-action="suggest" data-text="${attr(s)}">${esc(s.length > 70 ? s.slice(0, 68) + "…" : s)}</button>`).join("")}</div></div>`}
    </div>
    <form class="composer" id="composer">
      <textarea id="chat-input" rows="1" placeholder="Escribe tu mensaje… (Enter para enviar, Shift+Enter nueva línea)" maxlength="4000"></textarea>
      <button class="btn btn-primary" id="send-btn" type="submit" aria-label="Enviar">${icon("send")}</button>
    </form>
  </div>`);
  const log = $("#chat-log");
  log.scrollTop = log.scrollHeight;
  const input = $("#chat-input");
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px"; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); sendChat(input.value); });
  if (typeof prefill === "string" && prefill) sendChat(prefill);
}

const AGENT_LABEL = {
  ask_flights: "Flight Agent", ask_weather: "Weather Agent",
  create_trip: "CreateTrip", get_trips: "GetTrips", get_trip_details: "GetTrips", update_trip: "UpdateTrip",
  create_itinerary: "CreateItinerary", update_itinerary: "UpdateItinerary",
  create_reservation: "CreateReservation", get_reservations: "GetReservations", update_reservation: "UpdateReservation",
  get_user_preferences: "Preferencias", save_user_preferences: "Preferencias",
};

async function sendChat(text) {
  text = (text || "").trim();
  if (!text || state.busy) return;
  state.busy = true;
  const log = $("#chat-log");
  if (!state.chat.messages.length) log.innerHTML = "";
  state.chat.messages.push({ role: "user", text });
  const msg = { role: "assistant", text: "", blocks: [], agents: ["Orchestrator"] };
  state.chat.messages.push(msg);
  const index = state.chat.messages.length - 1;
  log.insertAdjacentHTML("beforeend", messageHtml({ role: "user", text }));
  log.insertAdjacentHTML("beforeend", `<div class="msg assistant" data-msg="${index}"><span class="avatar">${icon("bot")}</span><div class="bubble">
    <div class="agents"><span class="agent-pill on">Orchestrator</span></div>
    <div class="status-line"><span class="spinner"></span><span class="status-text">Conectando con el Orchestrator…</span></div>
    <div class="md typing"></div><p class="form-error hidden"></p><div class="blocks"></div></div></div>`);
  const el = log.querySelector(`[data-msg="${index}"]`);
  const mdEl = $(".md", el), statusEl = $(".status-line", el), blocksEl = $(".blocks", el), agentsEl = $(".agents", el);
  const input = $("#chat-input"); if (input) { input.value = ""; input.style.height = "auto"; }
  $("#send-btn").disabled = true;
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  scroll();
  const changed = new Set();
  const markAgent = (name) => {
    if (!msg.agents.includes(name)) msg.agents.push(name);
    agentsEl.innerHTML = msg.agents.map((a) => `<span class="agent-pill ${state.busy ? "on" : ""}">${esc(a)}</span>`).join("");
  };
  try {
    await streamChat(text, state.chat.sessionId, (ev) => {
      if (ev.type === "status") { $(".status-text", el).textContent = ev.text; statusEl.classList.remove("hidden"); }
      else if (ev.type === "tool") { if (AGENT_LABEL[ev.name]) markAgent(AGENT_LABEL[ev.name]); }
      else if (ev.type === "text") { msg.text += ev.text; mdEl.innerHTML = markdown(msg.text); statusEl.classList.add("hidden"); scroll(); }
      else if (ev.type === "ui") {
        msg.blocks.push(ev.block);
        if (ev.block.type === "weather") weatherCache(ev.block);
        blocksEl.insertAdjacentHTML("beforeend", renderBlock(ev.block)); hydrateIcons(blocksEl); scroll();
      }
      else if (ev.type === "data_changed") changed.add(ev.entity);
      else if (ev.type === "error") { msg.error = ev.text; const e = $(".form-error", el); e.textContent = ev.text; e.classList.remove("hidden"); }
    });
  } catch (err) {
    msg.error = err.message;
    const e = $(".form-error", el); e.textContent = err.message; e.classList.remove("hidden");
  } finally {
    state.busy = false;
    statusEl.classList.add("hidden");
    mdEl.classList.remove("typing");
    agentsEl.querySelectorAll(".agent-pill").forEach((p) => p.classList.remove("on"));
    if (!msg.text && !msg.blocks.length && !msg.error) { msg.text = "_(Sin respuesta)_"; mdEl.innerHTML = markdown(msg.text); }
    changed.forEach(invalidate);
    if (changed.size) toast("Datos actualizados en DynamoDB", "ok");
    saveChat();
    const btn = $("#send-btn"); if (btn) btn.disabled = false;
    $("#chat-input")?.focus();
  }
}

// Llamada al agente desde los módulos de vuelos/clima (renderiza solo los bloques estructurados).
async function askAgentForBlocks(prompt, container, { types, label }) {
  container.innerHTML = `<div class="card"><div class="agents"><span class="agent-pill on">Orchestrator</span><span class="agent-pill on">${esc(label)}</span></div>
    <div class="status-line"><span class="spinner"></span><span class="status-text">Enviando solicitud al Orchestrator…</span></div><div class="out"></div></div>`;
  const statusText = $(".status-text", container), out = $(".out", container);
  let text = "", got = 0;
  try {
    await streamChat(prompt, state.toolSession, (ev) => {
      if (ev.type === "status") statusText.textContent = ev.text;
      else if (ev.type === "text") text += ev.text;
      else if (ev.type === "ui" && types.includes(ev.block.type)) {
        got++;
        if (ev.block.type === "weather") weatherCache(ev.block);
        out.insertAdjacentHTML("beforeend", `<div style="margin-top:14px">${ev.block.type === "flights" ? flightsBlock(ev.block) : weatherBlock(ev.block)}</div>`);
        hydrateIcons(out);
      } else if (ev.type === "error") out.insertAdjacentHTML("beforeend", `<p class="form-error">${esc(ev.text)}</p>`);
    });
    $(".status-line", container).classList.add("hidden");
    container.querySelectorAll(".agent-pill").forEach((p) => p.classList.remove("on"));
    if (text.trim()) out.insertAdjacentHTML("beforeend", `<div class="md" style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">${markdown(text)}</div>`);
    if (!got && !text.trim()) out.innerHTML = `<div class="empty">Sin resultados.</div>`;
  } catch (err) {
    $(".status-line", container).classList.add("hidden");
    out.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

// ------------------------------------------------------------------ 3. Vuelos
function isoPlus(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

function renderFlights() {
  render(`<div class="page-head"><div><h1>Consulta de vuelos</h1><p>El Flight Agent busca vuelos reales mediante el MCP de vuelos y el frontend los compara en tarjetas.</p></div></div>
    <form class="card form-grid" id="flight-form" style="grid-template-columns:repeat(5,minmax(0,1fr));align-items:end">
      <label>Origen<input name="origin" required placeholder="Bogotá" value="Bogotá" /></label>
      <label>Destino<input name="destination" required placeholder="Cartagena" value="Cartagena" /></label>
      <label>Salida<input name="date" type="date" required value="${isoPlus(14)}" min="${isoPlus(0)}" /></label>
      <label>Regreso (opcional)<input name="returnDate" type="date" min="${isoPlus(0)}" /></label>
      <button class="btn btn-primary" type="submit">${icon("plane")} Buscar</button>
    </form>
    <div id="flight-results" style="margin-top:16px"></div>`);
  $("#flight-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.returnDate && d.returnDate < d.date) return toast("El regreso debe ser posterior a la salida", "error");
    const prompt = `Busca vuelos de ${d.origin} a ${d.destination} para el ${d.date}` + (d.returnDate ? ` y el regreso de ${d.destination} a ${d.origin} el ${d.returnDate}` : "") + ". Compáralos brevemente (más barato y mejor horario). No consultes el clima.";
    askAgentForBlocks(prompt, $("#flight-results"), { types: ["flights"], label: "Flight Agent" });
  });
  if (window.innerWidth < 760) $("#flight-form").style.gridTemplateColumns = "1fr";
}

// ------------------------------------------------------------------ 4. Clima
function renderWeather() {
  render(`<div class="page-head"><div><h1>Información meteorológica</h1><p>Temperatura, condiciones y probabilidad de lluvia por destino y fechas (Weather Agent · MCP de clima).</p></div></div>
    <form class="card form-grid" id="weather-form" style="grid-template-columns:repeat(4,minmax(0,1fr));align-items:end">
      <label>Destino<input name="city" required value="Cartagena" /></label>
      <label>Desde<input name="start" type="date" required value="${isoPlus(3)}" /></label>
      <label>Hasta<input name="end" type="date" required value="${isoPlus(6)}" /></label>
      <button class="btn btn-primary" type="submit">${icon("sun")} Consultar</button>
    </form>
    <div id="weather-results" style="margin-top:16px"></div>`);
  $("#weather-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (d.end < d.start) return toast("La fecha final debe ser posterior a la inicial", "error");
    askAgentForBlocks(`Consulta el clima en ${d.city} del ${d.start} al ${d.end}. Resume en una frase y no busques vuelos.`, $("#weather-results"), { types: ["weather"], label: "Weather Agent" });
  });
  if (window.innerWidth < 760) $("#weather-form").style.gridTemplateColumns = "1fr";
}

// ------------------------------------------------------------------ 5. Mis viajes e itinerarios
async function renderTrips() {
  skeleton("Mis viajes");
  const trips = await loadTrips();
  const upcoming = trips.filter((t) => (daysUntil(t.endDate) ?? 0) >= 0 && t.status !== "CANCELADO");
  const past = trips.filter((t) => !upcoming.includes(t));
  render(`<div class="page-head"><div><h1>Mis viajes</h1><p>Viajes guardados en DynamoDB, con su itinerario y reservas.</p></div>
      <div class="row"><a class="btn btn-ghost" href="#/asistente" data-action="demo">${icon("sparkles")} Planificar con IA</a>
      <button class="btn btn-primary" data-action="new-trip">${icon("plus")} Nuevo viaje</button></div></div>
    ${trips.length ? `
      <h2>Próximos</h2>${upcoming.length ? `<div class="cards-auto" style="margin-bottom:24px">${upcoming.map(tripCard).join("")}</div>` : `<p class="muted">Sin viajes próximos.</p>`}
      ${past.length ? `<h2>Anteriores y cancelados</h2><div class="cards-auto">${past.map(tripCard).join("")}</div>` : ""}`
      : `<div class="card empty"><div class="big-icon">${icon("map")}</div><p>Aún no tienes viajes. Créalo manualmente o pídeselo al asistente.</p></div>`}`);
}

async function renderTripDetail(tripId) {
  skeleton("Viaje");
  const { trip, itinerary, reservations } = await api.trip(tripId);
  const weather = weatherFor(trip.destination);
  render(`<div class="page-head">
      <div><a href="#/viajes" class="muted" style="text-decoration:none;font-weight:600">${icon("back")} Mis viajes</a>
        <h1 style="margin-top:6px">${esc(trip.title || trip.destination)} ${badge(trip.status)}</h1>
        <div class="meta"><span>${icon("calendar")} ${fmtRange(trip.startDate, trip.endDate)} · ${tripDays(trip)} días</span>
          ${trip.origin ? `<span>${icon("plane")} ${esc(trip.origin)} → ${esc(trip.destination)}</span>` : `<span>${icon("pin")} ${esc(trip.destination)}</span>`}
          <span>${icon("users")} ${trip.travelers} viajero${trip.travelers > 1 ? "s" : ""}</span>
          ${trip.budget != null ? `<span>${icon("wallet")} ${money(trip.budget, trip.currency)}</span>` : ""}</div></div>
      <div class="row">
        <button class="btn btn-accent" data-action="export-pdf">${icon("download")} Exportar PDF</button>
        <button class="btn btn-ghost" data-action="edit-trip">${icon("edit")} Editar</button>
        <button class="btn btn-danger" data-action="delete-trip">${icon("trash")}</button>
      </div></div>
    <div class="grid" style="grid-template-columns:minmax(0,1.7fr) minmax(0,1fr);align-items:start" id="trip-grid">
      <div class="card"><div class="card-title"><h2>${icon("calendar")} Itinerario</h2>
        <div class="row">${itinerary ? "" : `<button class="btn btn-sm btn-ghost" data-action="manual-itinerary">${icon("plus")} Crear manual</button>`}
        <button class="btn btn-sm btn-primary" data-action="ai-itinerary">${icon("sparkles")} ${itinerary ? "Regenerar" : "Generar"} con IA</button></div></div>
        ${itinerary ? itineraryBlock(itinerary, { currency: trip.currency, editable: true }) : `<div class="empty">Este viaje aún no tiene itinerario.</div>`}
      </div>
      <div class="stack">
        <div class="card"><div class="card-title"><h2>${icon("ticket")} Reservas</h2><button class="btn btn-sm btn-ghost" data-action="new-reservation" data-trip="${esc(trip.tripId)}">${icon("plus")} Nueva</button></div>
          ${reservationsBlock(reservations)}</div>
        ${weather ? `<div class="card">${weatherBlock(weather)}</div>` : `<div class="card"><h3>${icon("sun")} Clima</h3><p class="muted">Consulta el clima del destino para verlo aquí y en el PDF.</p>
          <button class="btn btn-sm btn-ghost" data-action="trip-weather">${icon("sun")} Consultar clima</button></div>`}
        ${trip.preferences?.length || trip.notes ? `<div class="card"><h3>Preferencias del viaje</h3><div class="chips">${(trip.preferences || []).map((p) => `<span class="chip" style="cursor:default">${esc(p)}</span>`).join("")}</div>${trip.notes ? `<p class="muted" style="margin-top:8px">${esc(trip.notes)}</p>` : ""}</div>` : ""}
      </div>
    </div>`);
  if (window.innerWidth < 1100) $("#trip-grid").style.gridTemplateColumns = "1fr";
  view.dataset.tripId = trip.tripId;
  state.currentTrip = { trip, itinerary, reservations };
}

// ------------------------------------------------------------------ 6. Reservas
async function renderReservations() {
  skeleton("Reservas");
  const [reservations, trips] = await Promise.all([loadReservations(), loadTrips()]);
  const filter = state.resFilter || { status: "", type: "", tripId: "" };
  const list = reservations.filter((r) => (!filter.status || r.status === filter.status) && (!filter.type || r.type === filter.type) && (!filter.tripId || r.tripId === filter.tripId));
  render(`<div class="page-head"><div><h1>Gestión de reservas</h1><p>Reservas simuladas pero persistentes. Ninguna incluye datos de pago.</p></div>
      <button class="btn btn-primary" data-action="new-reservation">${icon("plus")} Nueva reserva</button></div>
    <div class="card" style="margin-bottom:14px"><div class="row">
      <select id="f-status" style="width:auto"><option value="">Todos los estados</option>${["SIMULADA", "PENDIENTE", "CONFIRMADA", "CANCELADA"].map((s) => `<option ${filter.status === s ? "selected" : ""} value="${s}">${s[0] + s.slice(1).toLowerCase()}</option>`).join("")}</select>
      <select id="f-type" style="width:auto"><option value="">Todos los tipos</option>${Object.entries(RES_TYPES).map(([k, [, l]]) => `<option ${filter.type === k ? "selected" : ""} value="${k}">${l}</option>`).join("")}</select>
      <select id="f-trip" style="width:auto"><option value="">Todos los viajes</option>${trips.map((t) => `<option ${filter.tripId === t.tripId ? "selected" : ""} value="${esc(t.tripId)}">${esc(t.title)}</option>`).join("")}</select>
      <span class="spacer"></span><span class="badge badge-simulada">Simulada</span><span class="badge badge-pendiente">Pendiente</span><span class="badge badge-confirmada">Confirmada (proveedor real)</span>
    </div></div>
    <div class="card">${reservationsBlock(list)}</div>`);
  ["status", "type", "trip"].forEach((k) => $(`#f-${k}`).addEventListener("change", (e) => {
    state.resFilter = { ...filter, [k === "trip" ? "tripId" : k]: e.target.value };
    renderReservations();
  }));
}

// ------------------------------------------------------------------ Preferencias
async function renderPreferences() {
  skeleton("Preferencias");
  const prefs = state.preferences || (state.preferences = await api.preferences());
  const list = (v) => esc((v || []).join(", "));
  const opt = (name, values, current) => `<select name="${name}"><option value="">—</option>${values.map(([v, l]) => `<option value="${v}" ${current === v ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  render(`<div class="page-head"><div><h1>Preferencias de viaje</h1><p>El Orchestrator las usa para personalizar vuelos, itinerarios y recomendaciones.</p></div></div>
    <form class="card form-grid" id="prefs-form">
      <label class="full">Tipos de actividades (separados por coma)<input name="activityTypes" value="${list(prefs.activityTypes)}" placeholder="playa, museos, gastronomía" /></label>
      <label>Nivel de presupuesto${opt("budgetLevel", [["ECONOMICO", "Económico"], ["MEDIO", "Medio"], ["ALTO", "Alto"], ["LUJO", "Lujo"]], prefs.budgetLevel)}</label>
      <label>Ciudad de residencia<input name="homeCity" value="${esc(prefs.homeCity || "")}" placeholder="Bogotá" /></label>
      <label>Aerolíneas preferidas<input name="preferredAirlines" value="${list(prefs.preferredAirlines)}" placeholder="Avianca, LATAM" /></label>
      <label>Restricciones alimentarias<input name="dietaryRestrictions" value="${list(prefs.dietaryRestrictions)}" placeholder="vegetariano" /></label>
      <label>Asiento${opt("seat", [["VENTANA", "Ventana"], ["PASILLO", "Pasillo"], ["INDIFERENTE", "Indiferente"]], prefs.seat)}</label>
      <label>Horario de vuelo${opt("preferredDepartureTime", [["MANANA", "Mañana"], ["TARDE", "Tarde"], ["NOCHE", "Noche"], ["INDIFERENTE", "Indiferente"]], prefs.preferredDepartureTime)}</label>
      <label class="full">Notas<textarea name="notes" maxlength="500">${esc(prefs.notes || "")}</textarea></label>
      <div class="full row"><span class="spacer"></span><button class="btn btn-primary" type="submit">${icon("check")} Guardar preferencias</button></div>
    </form>
    <div class="card" style="margin-top:14px"><h3>Guardado actualmente</h3>${preferencesSummary(prefs)}</div>`);
  $("#prefs-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    const d = formData(e.target);
    const body = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== ""));
    setLoading(btn, true);
    try {
      state.preferences = await api.savePreferences(body);
      toast("Preferencias guardadas", "ok");
      renderPreferences();
    } catch (err) { toast(err.message, "error"); setLoading(btn, false); }
  });
}

// ------------------------------------------------------------------ formularios (modales)
function tripForm(trip = null) {
  const t = trip || { travelers: 1, currency: "COP", startDate: isoPlus(14), endDate: isoPlus(17) };
  modal(`<div class="card-title"><h2>${trip ? "Editar viaje" : "Nuevo viaje"}</h2><button class="icon-btn" data-close>${icon("x")}</button></div>
    <form class="form-grid" id="trip-form">
      <label class="full">Título<input name="title" maxlength="100" value="${esc(t.title || "")}" placeholder="Vacaciones en Cartagena" /></label>
      <label>Origen<input name="origin" maxlength="80" value="${esc(t.origin || "")}" placeholder="Bogotá" /></label>
      <label>Destino *<input name="destination" required maxlength="80" value="${esc(t.destination || "")}" /></label>
      <label>Salida *<input name="startDate" type="date" required value="${esc(t.startDate)}" /></label>
      <label>Regreso *<input name="endDate" type="date" required value="${esc(t.endDate)}" /></label>
      <label>Viajeros<input name="travelers" type="number" min="1" max="20" value="${t.travelers || 1}" /></label>
      <label>Presupuesto<div class="row" style="flex-wrap:nowrap"><input name="budget" type="number" min="0" step="any" value="${t.budget ?? ""}" />
        <select name="currency" style="width:90px">${["COP", "USD", "EUR"].map((c) => `<option ${t.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select></div></label>
      ${trip ? `<label>Estado<select name="status">${["PLANIFICADO", "CONFIRMADO", "EN_CURSO", "COMPLETADO", "CANCELADO"].map((s) => `<option ${t.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>` : ""}
      <label class="full">Preferencias (separadas por coma)<input name="preferences" value="${esc((t.preferences || []).join(", "))}" placeholder="playa, gastronomía" /></label>
      <label class="full">Notas<textarea name="notes" maxlength="1000">${esc(t.notes || "")}</textarea></label>
      <p class="form-error full" id="trip-error"></p>
      <div class="full row"><span class="spacer"></span><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" type="submit">Guardar</button></div>
    </form>`, {
    onMount: (root, close) => $("#trip-form", root).addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      if (d.endDate < d.startDate) return ($("#trip-error", root).textContent = "La fecha de regreso no puede ser anterior a la salida.");
      const body = { ...d, travelers: Number(d.travelers || 1), budget: d.budget === "" ? undefined : Number(d.budget), preferences: d.preferences ? d.preferences.split(",").map((s) => s.trim()).filter(Boolean) : [] };
      const btn = e.target.querySelector("button[type=submit]");
      setLoading(btn, true);
      try {
        const saved = trip ? await api.updateTrip(trip.tripId, body) : await api.createTrip(body);
        invalidate("trips");
        close();
        toast(trip ? "Viaje actualizado" : "Viaje creado", "ok");
        location.hash = `#/viajes/${encodeURIComponent(saved.tripId)}`;
        if (trip) route();
      } catch (err) { $("#trip-error", root).textContent = err.message; setLoading(btn, false); }
    }),
  });
}

async function reservationForm(res = null, preset = {}) {
  const trips = await loadTrips();
  if (!trips.length) { toast("Primero crea un viaje para asociar la reserva", "error"); return tripForm(); }
  const r = res || { type: "FLIGHT", status: "SIMULADA", currency: "COP", ...preset };
  const trip0 = trips.find((t) => t.tripId === r.tripId) || trips[0];
  modal(`<div class="card-title"><h2>${res ? "Editar reserva" : "Nueva reserva"}</h2><button class="icon-btn" data-close>${icon("x")}</button></div>
    <form class="form-grid" id="res-form">
      <label class="full">Viaje asociado *<select name="tripId" required>${trips.map((t) => `<option value="${esc(t.tripId)}" ${t.tripId === trip0.tripId ? "selected" : ""}>${esc(t.title)} (${fmtRange(t.startDate, t.endDate)})</option>`).join("")}</select></label>
      <label>Tipo *<select name="type">${Object.entries(RES_TYPES).map(([k, [, l]]) => `<option value="${k}" ${r.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Estado<select name="status">${["SIMULADA", "PENDIENTE", ...(res ? ["CANCELADA"] : [])].map((s) => `<option ${r.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label class="full">Descripción *<input name="title" required maxlength="120" value="${esc(r.title || "")}" placeholder="Vuelo BOG → CTG / Hotel Las Américas / Tour Islas del Rosario" /></label>
      <label>Fecha *<input name="date" type="date" required value="${esc(r.date || trip0.startDate)}" /></label>
      <label>Hora<input name="time" type="time" value="${esc(r.time || "")}" /></label>
      <label>Proveedor<input name="provider" maxlength="80" value="${esc(r.provider || "")}" placeholder="Aerolínea, hotel u operador" /></label>
      <label>Precio total<div class="row" style="flex-wrap:nowrap"><input name="price" type="number" min="0" step="any" value="${r.price ?? ""}" />
        <select name="currency" style="width:90px">${["COP", "USD", "EUR"].map((c) => `<option ${r.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select></div></label>
      <label class="full">Detalles<textarea name="details" maxlength="500">${esc(r.details || "")}</textarea></label>
      <p class="muted full" style="font-size:.82rem">${icon("info")} Reserva simulada: no se solicitan ni almacenan datos de pago. "Confirmada" solo aplica con un proveedor real.</p>
      <p class="form-error full" id="res-error"></p>
      <div class="full row"><span class="spacer"></span><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" type="submit">Guardar</button></div>
    </form>`, {
    onMount: (root, close) => $("#res-form", root).addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const body = { ...d, price: d.price === "" ? undefined : Number(d.price) };
      if (!body.time) delete body.time;
      const btn = e.target.querySelector("button[type=submit]");
      setLoading(btn, true);
      try {
        if (res) await api.updateReservation(res.reservationId, body); else await api.createReservation(body);
        invalidate("reservations");
        close();
        toast(res ? "Reserva actualizada" : "Reserva registrada (simulada)", "ok");
        route();
      } catch (err) { $("#res-error", root).textContent = err.message; setLoading(btn, false); }
    }),
  });
}

function activityForm(day) {
  modal(`<div class="card-title"><h2>Agregar actividad · Día ${day}</h2><button class="icon-btn" data-close>${icon("x")}</button></div>
    <form class="form-grid" id="act-form">
      <label>Hora<input name="time" type="time" value="10:00" /></label>
      <label>Categoría<select name="category">${["CULTURA", "PLAYA", "COMIDA", "NATURALEZA", "AVENTURA", "TOUR", "COMPRAS", "VIDA_NOCTURNA", "DESCANSO", "TRANSPORTE", "HOSPEDAJE", "OTRO"].map((c) => `<option>${c}</option>`).join("")}</select></label>
      <label class="full">Actividad *<input name="title" required maxlength="120" /></label>
      <label>Lugar<input name="location" maxlength="120" /></label>
      <label>Costo estimado<input name="estimatedCost" type="number" min="0" step="any" /></label>
      <label class="full">Descripción<textarea name="description" maxlength="500"></textarea></label>
      <p class="form-error full" id="act-error"></p>
      <div class="full row"><span class="spacer"></span><button type="button" class="btn btn-ghost" data-close>Cancelar</button><button class="btn btn-primary" type="submit">Agregar</button></div>
    </form>`, {
    onMount: (root, close) => $("#act-form", root).addEventListener("submit", async (e) => {
      e.preventDefault();
      const a = formData(e.target);
      if (a.estimatedCost === "") delete a.estimatedCost; else a.estimatedCost = Number(a.estimatedCost);
      const { trip, itinerary } = state.currentTrip;
      const current = (itinerary?.days || []).find((d) => Number(d.day) === day) || { day, title: `Día ${day}`, activities: [] };
      const btn = e.target.querySelector("button[type=submit]");
      setLoading(btn, true);
      try {
        const payload = { day: { ...current, activities: [...(current.activities || []), a] } };
        if (itinerary) await api.updateItinerary(trip.tripId, payload);
        else await api.createItinerary(trip.tripId, { days: [payload.day] });
        close(); toast("Actividad agregada", "ok"); renderTripDetail(trip.tripId);
      } catch (err) { $("#act-error", root).textContent = err.message; setLoading(btn, false); }
    }),
  });
}

// ------------------------------------------------------------------ acciones globales (delegación)
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const ct = state.currentTrip;
  switch (action) {
    case "demo":
      e.preventDefault();
      location.hash = "#/asistente";
      setTimeout(() => { const i = $("#chat-input"); if (i) { i.value = DEMO_PROMPT; i.dispatchEvent(new Event("input")); i.focus(); } }, 50);
      break;
    case "suggest": sendChat(JSON.parse(el.dataset.text)); break;
    case "new-chat":
      state.chat = { sessionId: newSessionId(), messages: [] }; saveChat(); renderChat(); break;
    case "open-trip": location.hash = `#/viajes/${encodeURIComponent(el.dataset.id)}`; break;
    case "new-trip": tripForm(); break;
    case "edit-trip": tripForm(ct.trip); break;
    case "delete-trip":
      if (confirm(`¿Eliminar "${ct.trip.title}" con su itinerario y reservas? Esta acción no se puede deshacer.`)) {
        try { await api.deleteTrip(ct.trip.tripId); invalidate("trips"); toast("Viaje eliminado", "ok"); location.hash = "#/viajes"; }
        catch (err) { toast(err.message, "error"); }
      }
      break;
    case "new-reservation": reservationForm(null, el.dataset.trip ? { tripId: el.dataset.trip } : {}); break;
    case "edit-reservation": reservationForm(JSON.parse(el.dataset.res)); break;
    case "reserve-flight": {
      const f = JSON.parse(el.dataset.flight);
      const trips = await loadTrips();
      const match = trips.find((t) => f.date && t.startDate <= f.date && f.date <= t.endDate);
      reservationForm(null, {
        type: "FLIGHT", tripId: match?.tripId, title: `Vuelo ${f.origin} → ${f.destination} ${f.flight}`.slice(0, 120),
        provider: f.airline, date: f.date, time: f.departure, price: f.amount, currency: ["USD", "COP", "EUR"].includes(f.currency) ? f.currency : "USD",
        details: `${f.stops ? f.stops + " escala(s)" : "Directo"} · Precio por persona ${f.price}`,
      });
      break;
    }
    case "export-pdf":
      try {
        const name = exportTripPdf({ ...ct, weather: weatherFor(ct.trip.destination), user: state.user });
        toast(`PDF generado: ${name}`, "ok");
      } catch (err) { toast(err.message, "error"); }
      break;
    case "ai-itinerary": {
      const t = ct.trip;
      location.hash = "#/asistente";
      setTimeout(() => sendChat(`${ct.itinerary ? "Regenera" : "Genera"} el itinerario de mi viaje "${t.title}" (id ${t.tripId}) a ${t.destination} del ${t.startDate} al ${t.endDate} para ${t.travelers} viajeros${t.budget ? ` con presupuesto de ${t.budget} ${t.currency}` : ""}. Consulta el clima para adaptarlo y guárdalo.`), 80);
      break;
    }
    case "trip-weather": {
      const t = ct.trip;
      location.hash = "#/clima";
      setTimeout(() => {
        const f = $("#weather-form"); if (!f) return;
        f.city.value = t.destination; f.start.value = t.startDate; f.end.value = t.endDate; f.requestSubmit();
      }, 50);
      break;
    }
    case "manual-itinerary": activityForm(1); break;
    case "add-activity": activityForm(Number(el.dataset.day)); break;
    case "remove-activity": {
      const day = Number(el.dataset.day), index = Number(el.dataset.index);
      const d = ct.itinerary.days.find((x) => Number(x.day) === day);
      const activities = d.activities.filter((_, i) => i !== index);
      try { await api.updateItinerary(ct.trip.tripId, { day: { ...d, activities } }); toast("Actividad eliminada", "ok"); renderTripDetail(ct.trip.tripId); }
      catch (err) { toast(err.message, "error"); }
      break;
    }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#modal-root").innerHTML = "";
  if (e.key === "Enter" && e.target.matches?.(".trip-card")) e.target.click();
});

// ------------------------------------------------------------------ arranque
initAuthScreen();
startApp().catch((err) => { console.error(err); showAuth(); });
