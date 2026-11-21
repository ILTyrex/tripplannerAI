// Componentes visuales. Agent-Driven UI: los agentes devuelven datos estructurados y aquí se
// transforman en tarjetas (vuelos, clima, viajes, itinerarios, reservas).
import { icon } from "./icons.js";

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const attr = (obj) => esc(JSON.stringify(obj));

const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export function parseDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return y ? new Date(y, (m || 1) - 1, d || 1) : null;
}
export function fmtDate(iso, opts = {}) {
  const d = parseDate(iso);
  if (!d) return "—";
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${opts.weekday ? DAYS[d.getDay()] + " " : ""}${base}${opts.year === false ? "" : " " + d.getFullYear()}`;
}
export function fmtRange(a, b) {
  const d1 = parseDate(a), d2 = parseDate(b);
  if (!d1) return "—";
  if (!d2 || a === b) return fmtDate(a);
  const sameYear = d1.getFullYear() === d2.getFullYear();
  return `${fmtDate(a, { year: !sameYear ? undefined : false })} – ${fmtDate(b)}`;
}
export function tripDays(trip) {
  const d1 = parseDate(trip.startDate), d2 = parseDate(trip.endDate);
  return d1 && d2 ? Math.round((d2 - d1) / 86400000) + 1 : 0;
}
export function daysUntil(iso) {
  const d = parseDate(iso);
  if (!d) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}
export function money(amount, currency = "COP") {
  if (amount === null || amount === undefined || amount === "") return "—";
  const n = Number(amount);
  if (Number.isNaN(n)) return esc(amount);
  try {
    return new Intl.NumberFormat("es-CO", { style: "currency", currency, maximumFractionDigits: currency === "COP" ? 0 : 2 }).format(n);
  } catch {
    return `${n.toLocaleString("es-CO")} ${esc(currency)}`;
  }
}

// Markdown mínimo y seguro (escapa todo antes de aplicar formato).
export function markdown(text) {
  const lines = esc(text || "").split(/\n/);
  let html = "", list = null;
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,!?:;]|$)/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*[-•*]\s+(.*)/))) {
      if (list !== "ul") { close(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== "ol") { close(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^#{1,4}\s+(.*)/))) {
      close(); html += `<p><b>${inline(m[1])}</b></p>`;
    } else if (!line.trim()) {
      close();
    } else {
      close(); html += `<p>${inline(line)}</p>`;
    }
  }
  close();
  return html;
}

// ---------------------------------------------------------------- badges
const STATUS = {
  SIMULADA: ["badge-simulada", "Simulada"],
  PENDIENTE: ["badge-pendiente", "Pendiente"],
  CONFIRMADA: ["badge-confirmada", "Confirmada"],
  CANCELADA: ["badge-cancelada", "Cancelada"],
  PLANIFICADO: ["badge-primary", "Planificado"],
  CONFIRMADO: ["badge-confirmada", "Confirmado"],
  EN_CURSO: ["badge-accent", "En curso"],
  COMPLETADO: ["badge-neutral", "Completado"],
  CANCELADO: ["badge-cancelada", "Cancelado"],
};
export function badge(status) {
  const [cls, label] = STATUS[status] || ["badge-neutral", status || "—"];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}
export const RES_TYPES = { FLIGHT: ["plane", "Vuelo"], HOTEL: ["hotel", "Hotel"], ACTIVITY: ["activity", "Actividad"] };

// ---------------------------------------------------------------- vuelos
export function flightsBlock(block, { actions = true } = {}) {
  const flights = block.flights || [];
  const head = `<div class="flight-head">${icon("plane")} ${esc(block.origin || "Origen")} ${icon("arrow")} ${esc(block.destination || "Destino")}
    ${block.date ? `<span class="badge badge-neutral">${fmtDate(block.date, { weekday: true })}</span>` : ""}
    ${flights.length ? `<span class="muted" style="font-weight:600;font-size:.85rem">${flights.length} opciones · Flight Agent · MCP de vuelos</span>` : ""}</div>`;
  if (!flights.length) return `<div>${head}<div class="empty">${esc(block.message || "No se encontraron vuelos.")}</div></div>`;
  const min = Math.min(...flights.map((f) => f.amount ?? Infinity));
  const cards = flights.map((f) => `
    <div class="flight-card ${f.cheapest ? "cheapest" : ""}">
      <div class="row"><span class="airline">${esc(f.airline)}</span><span class="spacer"></span>${f.cheapest ? '<span class="badge badge-confirmada">Más barato</span>' : ""}</div>
      <div class="row"><span class="time">${icon("clock")} ${esc(f.departure)}</span><span class="muted">${f.stops ? `${f.stops} escala${f.stops > 1 ? "s" : ""}` : "Directo"}</span></div>
      <div class="muted" style="font-size:.84rem">${esc(f.flight)}</div>
      <div class="row"><span class="price">${esc(f.price)}</span>
        ${f.amount != null && f.amount > min ? `<small class="muted">+${Math.round(f.amount - min)} ${esc(f.currency || "")}</small>` : ""}</div>
      ${actions ? `<button class="btn btn-sm btn-ghost" data-action="reserve-flight" data-flight="${attr({ ...f, origin: block.origin, destination: block.destination, date: block.date })}">${icon("ticket")} Reservar (simulada)</button>` : ""}
    </div>`).join("");
  return `<div>${head}<div class="flight-grid">${cards}</div></div>`;
}

// ---------------------------------------------------------------- clima
export function weatherBlock(block) {
  const days = block.days || [];
  const head = `<div class="flight-head">${icon("sun")} Clima en ${esc(block.city || "destino")}${block.country ? `, ${esc(block.country)}` : ""}
    <span class="muted" style="font-weight:600;font-size:.85rem">Weather Agent · MCP de clima</span></div>`;
  if (!days.length) return `<div>${head}<div class="empty">${esc(block.error || block.message || "Pronóstico no disponible.")}</div></div>`;
  const cards = days.map((d) => `
    <div class="weather-card">
      <div class="row"><b>${fmtDate(d.date, { weekday: true, year: false })}</b>${d.estimated ? '<span class="badge badge-neutral" title="Estimado con el histórico del año anterior">Est.</span>' : ""}</div>
      <div class="w-icon">${icon(d.icon || "cloud")}</div>
      <div style="font-weight:600">${esc(d.condition)}</div>
      <div class="temps">${d.tempMax != null ? Math.round(d.tempMax) + "°" : "—"} <small class="muted">/ ${d.tempMin != null ? Math.round(d.tempMin) + "°" : "—"}</small></div>
      ${d.rainProbability != null
        ? `<div class="rain">${icon("droplet")} ${d.rainProbability}%<span class="rain-bar"><i style="width:${Math.min(100, d.rainProbability)}%"></i></span></div>`
        : `<div class="rain">${icon("droplet")} ${d.precipitationMm != null ? d.precipitationMm + " mm" : "—"}</div>`}
    </div>`).join("");
  const note = block.source && block.source !== "pronostico" ? `<p class="muted" style="font-size:.82rem;margin-top:8px">${icon("info")} ${esc(block.sourceNote || "")}</p>` : "";
  return `<div>${head}<div class="weather-grid">${cards}</div>${note}</div>`;
}

// ---------------------------------------------------------------- viajes
export function tripCard(trip) {
  const until = daysUntil(trip.startDate);
  const when = until == null ? "" : until > 0 ? `En ${until} día${until === 1 ? "" : "s"}` : until === 0 ? "¡Hoy!" : tripDays(trip) + until > 0 ? "En curso" : "Finalizado";
  return `<article class="card trip-card" data-action="open-trip" data-id="${esc(trip.tripId)}" tabindex="0">
    <span class="band"></span>
    <div class="row"><span class="dest">${esc(trip.destination)}</span><span class="spacer"></span>${badge(trip.status)}</div>
    <div class="muted" style="font-weight:600">${esc(trip.title || "")}</div>
    <div class="meta">
      <span>${icon("calendar")} ${fmtRange(trip.startDate, trip.endDate)}</span>
      ${trip.origin ? `<span>${icon("plane")} desde ${esc(trip.origin)}</span>` : ""}
      <span>${icon("users")} ${trip.travelers || 1}</span>
      ${trip.budget != null ? `<span>${icon("wallet")} ${money(trip.budget, trip.currency)}</span>` : ""}
    </div>
    ${when ? `<span class="badge badge-accent" style="align-self:flex-start">${when}</span>` : ""}
  </article>`;
}

export function tripsBlock(block) {
  const trips = block.trips || [];
  if (!trips.length) return `<div class="empty">Aún no tienes viajes guardados.</div>`;
  return `<div class="cards-auto">${trips.map(tripCard).join("")}</div>`;
}

// ---------------------------------------------------------------- itinerario
const CATEGORY = {
  TRANSPORTE: "plane", HOSPEDAJE: "hotel", COMIDA: "sparkles", CULTURA: "map", PLAYA: "sun", NATURALEZA: "pin",
  AVENTURA: "activity", COMPRAS: "wallet", VIDA_NOCTURNA: "sparkles", DESCANSO: "home", TOUR: "map", OTRO: "pin",
};
export function itineraryBlock(itinerary, { currency = "COP", editable = false } = {}) {
  const days = itinerary?.days || [];
  if (!days.length) return `<div class="empty">Sin itinerario todavía.</div>`;
  const total = days.flatMap((d) => d.activities || []).reduce((s, a) => s + (Number(a.estimatedCost) || 0), 0);
  return `<div class="agenda">
    ${days.map((d) => `
      <section class="agenda-day">
        <header>
          <span class="day-num"><span>DÍA</span><b>${d.day}</b></span>
          <div><b>${esc(d.title)}</b><div class="muted" style="font-size:.85rem">${fmtDate(d.date, { weekday: true })}</div></div>
          <span class="spacer"></span>
          ${editable ? `<button class="btn btn-sm btn-ghost" data-action="add-activity" data-day="${d.day}">${icon("plus")} Actividad</button>` : ""}
        </header>
        ${(d.activities || []).map((a, i) => `
          <div class="activity">
            <span class="a-time">${esc(a.time || "—")}</span>
            <div><div class="a-title">${icon(CATEGORY[a.category] || "pin")} ${esc(a.title)}</div>
              ${a.description ? `<div class="a-desc">${esc(a.description)}</div>` : ""}
              ${a.location ? `<div class="a-desc">${icon("pin")} ${esc(a.location)}</div>` : ""}</div>
            <div class="row" style="justify-content:flex-end">
              ${a.estimatedCost ? `<span class="a-cost">${money(a.estimatedCost, currency)}</span>` : ""}
              ${editable ? `<button class="icon-btn" title="Eliminar" data-action="remove-activity" data-day="${d.day}" data-index="${i}">${icon("trash")}</button>` : ""}
            </div>
          </div>`).join("") || `<div class="activity"><span></span><span class="muted">Día libre</span></div>`}
      </section>`).join("")}
    ${itinerary.notes ? `<div class="card" style="background:var(--surface-2);box-shadow:none">${icon("info")} ${esc(itinerary.notes)}</div>` : ""}
    ${total ? `<div class="row"><span class="muted" style="font-weight:600">Costo estimado de actividades:</span><b>${money(total, currency)}</b></div>` : ""}
  </div>`;
}

// ---------------------------------------------------------------- reservas
export function reservationItem(r, { actions = true } = {}) {
  const [ic, label] = RES_TYPES[r.type] || ["ticket", r.type];
  return `<div class="res-item">
    <span class="res-icon">${icon(ic)}</span>
    <div style="min-width:0">
      <div class="r-title">${esc(r.title)}</div>
      <div class="r-meta">${label} · ${fmtDate(r.date, { weekday: true })}${r.time ? " · " + esc(r.time) : ""}${r.provider ? " · " + esc(r.provider) : ""}${r.tripTitle ? " · " + esc(r.tripTitle) : ""}</div>
      <div class="r-meta">Código ${esc(r.confirmationCode || "—")}</div>
    </div>
    <div class="res-right">
      ${badge(r.status)}
      ${r.price != null ? `<b style="font-size:.9rem">${money(r.price, r.currency)}</b>` : ""}
      ${actions ? `<button class="btn btn-sm btn-ghost" data-action="edit-reservation" data-res="${attr(r)}">${icon("edit")} Editar</button>` : ""}
    </div>
  </div>`;
}
export function reservationsBlock(list, opts) {
  if (!list?.length) return `<div class="empty">No hay reservas.</div>`;
  return `<div class="res-list">${list.map((r) => reservationItem(r, opts)).join("")}</div>`;
}

// ---------------------------------------------------------------- bloque genérico (chat)
export function renderBlock(block) {
  switch (block?.type) {
    case "flights": return `<div><div class="block-title">${icon("plane")} Vuelos</div>${flightsBlock(block)}</div>`;
    case "weather": return `<div><div class="block-title">${icon("sun")} Clima</div>${weatherBlock(block)}</div>`;
    case "trip": return block.trip ? `<div><div class="block-title">${icon("map")} Viaje guardado</div><div class="cards-auto">${tripCard(block.trip)}</div></div>` : "";
    case "trips": return `<div><div class="block-title">${icon("map")} Tus viajes</div>${tripsBlock(block)}</div>`;
    case "itinerary": return `<div><div class="block-title">${icon("calendar")} Itinerario ${block.itinerary?.destination ? "· " + esc(block.itinerary.destination) : ""}
      ${block.itinerary?.tripId ? `<button class="btn btn-sm btn-ghost" data-action="open-trip" data-id="${esc(block.itinerary.tripId)}" style="margin-left:auto">Ver viaje ${icon("arrow")}</button>` : ""}</div>${itineraryBlock(block.itinerary, { currency: block.trip?.currency })}</div>`;
    case "reservation": return block.reservation ? `<div><div class="block-title">${icon("ticket")} Reserva registrada</div>${reservationsBlock([block.reservation])}</div>` : "";
    case "reservations": return `<div><div class="block-title">${icon("ticket")} Reservas</div>${reservationsBlock(block.reservations)}</div>`;
    case "preferences": return `<div><div class="block-title">${icon("sliders")} Preferencias guardadas</div>${preferencesSummary(block.preferences)}</div>`;
    default: return "";
  }
}

export function preferencesSummary(p = {}) {
  const items = [
    ["Actividades", (p.activityTypes || []).join(", ")],
    ["Presupuesto", p.budgetLevel],
    ["Aerolíneas", (p.preferredAirlines || []).join(", ")],
    ["Restricciones", (p.dietaryRestrictions || []).join(", ")],
    ["Asiento", p.seat],
    ["Horario", p.preferredDepartureTime],
    ["Ciudad", p.homeCity],
    ["Notas", p.notes],
  ].filter(([, v]) => v);
  if (!items.length) return `<div class="empty">Sin preferencias guardadas.</div>`;
  return `<div class="chips">${items.map(([k, v]) => `<span class="chip" style="cursor:default"><b>${k}:</b> ${esc(v)}</span>`).join("")}</div>`;
}
