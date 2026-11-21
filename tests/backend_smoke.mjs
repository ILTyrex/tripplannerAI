// Prueba de humo del Canal 1 (Frontend -> API Gateway -> Lambda -> DynamoDB).
// Uso: node tests/backend_smoke.mjs   (lee la configuración de frontend/js/config.js y
// las credenciales de prueba de .env.test.local; si no existen las crea).
import fs from "node:fs";
import crypto from "node:crypto";

const cfgText = fs.readFileSync(new URL("../frontend/js/config.js", import.meta.url), "utf8");
const cfg = JSON.parse(cfgText.slice(cfgText.indexOf("{"), cfgText.lastIndexOf("}") + 1));
const envFile = new URL("../.env.test.local", import.meta.url);

function loadOrCreateUser(suffix = "") {
  const env = fs.existsSync(envFile) ? Object.fromEntries(
    fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split("=", 2))) : {};
  const key = `TEST_USER${suffix}`;
  if (!env[`${key}_EMAIL`]) {
    env[`${key}_EMAIL`] = `demo${suffix.toLowerCase()}.${crypto.randomBytes(3).toString("hex")}@tripplanner.test`;
    env[`${key}_PASSWORD`] = `Tp${crypto.randomBytes(6).toString("hex")}9`;
    fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  }
  return { email: env[`${key}_EMAIL`], password: env[`${key}_PASSWORD`] };
}

async function cognito(target, body) {
  const r = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.message || data.__type), { type: data.__type });
  return data;
}

async function login({ email, password }) {
  try {
    await cognito("SignUp", { ClientId: cfg.userPoolClientId, Username: email, Password: password, UserAttributes: [{ Name: "email", Value: email }, { Name: "name", Value: "Demo" }] });
  } catch (e) { if (e.type !== "UsernameExistsException") throw e; }
  const auth = await cognito("InitiateAuth", { ClientId: cfg.userPoolClientId, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: email, PASSWORD: password } });
  return auth.AuthenticationResult.AccessToken;
}

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) failures++;
}

async function api(token, method, path, body) {
  const r = await fetch(cfg.apiUrl + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

const tokenA = await login(loadOrCreateUser("_A"));
const tokenB = await login(loadOrCreateUser("_B"));

check("sin token -> 401", (await fetch(cfg.apiUrl + "/trips")).status === 401);
let r = await api(tokenA, "GET", "/me");
check("GET /me crea perfil", r.status === 200 && r.data.profile?.userId, JSON.stringify(r.data));

r = await api(tokenA, "PUT", "/preferences", { activityTypes: ["playa", "gastronomía"], budgetLevel: "medio", seat: "ventana" });
check("PUT /preferences", r.status === 200 && r.data.budgetLevel === "MEDIO", JSON.stringify(r.data));

r = await api(tokenA, "POST", "/trips", { destination: "Cartagena", origin: "Bogotá", startDate: "2026-12-10", endDate: "2026-12-13", travelers: 3, budget: 5000000, currency: "COP" });
check("POST /trips -> 201", r.status === 201 && r.data.tripId, JSON.stringify(r.data));
const tripId = r.data.tripId;

r = await api(tokenA, "POST", "/trips", { destination: "X", startDate: "2026-12-10", endDate: "2026-12-01" });
check("validación fechas -> 400", r.status === 400, JSON.stringify(r.data));

r = await api(tokenA, "POST", `/trips/${tripId}/itinerary`, { days: [
  { day: 1, title: "Llegada", activities: [{ time: "15:00", title: "Check-in hotel", category: "hospedaje" }, { time: "18:00", title: "Atardecer en Café del Mar", category: "cultura", estimatedCost: 150000 }] },
  { day: 2, title: "Islas", activities: [{ time: "08:00", title: "Tour Islas del Rosario", category: "playa", estimatedCost: 900000 }] },
] });
check("POST itinerary -> 201", r.status === 201 && r.data.days?.length === 2, JSON.stringify(r.data));

r = await api(tokenA, "PUT", `/trips/${tripId}/itinerary`, { day: { day: 3, title: "Centro", activities: [{ time: "10:00", title: "Ciudad amurallada" }] } });
check("PUT itinerary (un día)", r.status === 200 && r.data.days?.length === 3, JSON.stringify(r.data));

r = await api(tokenA, "POST", "/reservations", { tripId, type: "FLIGHT", title: "Vuelo BOG → CTG", date: "2026-12-10", time: "07:15", provider: "Avianca", price: 450, currency: "USD" });
check("POST reserva SIMULADA", r.status === 201 && r.data.status === "SIMULADA" && r.data.confirmationCode?.startsWith("SIM-"), JSON.stringify(r.data));
const resId = r.data.reservationId;

r = await api(tokenA, "POST", "/reservations", { tripId, type: "HOTEL", title: "Hotel", date: "2026-12-10", status: "CONFIRMADA" });
check("CONFIRMADA rechazada sin proveedor -> 400", r.status === 400, JSON.stringify(r.data));

r = await api(tokenA, "POST", "/reservations", { tripId, type: "HOTEL", title: "Hotel", date: "2026-12-10", details: "pago con 4111 1111 1111 1111" });
check("datos de tarjeta rechazados -> 400", r.status === 400, JSON.stringify(r.data));

r = await api(tokenA, "PUT", `/reservations/${resId}`, { status: "PENDIENTE" });
check("PUT reserva -> PENDIENTE", r.status === 200 && r.data.status === "PENDIENTE", JSON.stringify(r.data));

r = await api(tokenA, "GET", `/trips/${tripId}`);
check("GET viaje con itinerario y reservas", r.status === 200 && r.data.itinerary && r.data.reservations.length === 1, JSON.stringify(r.data).slice(0, 300));

r = await api(tokenB, "GET", `/trips/${tripId}`);
check("aislamiento por usuario (B no ve viaje de A) -> 404", r.status === 404, JSON.stringify(r.data));
r = await api(tokenB, "PUT", `/reservations/${resId}`, { status: "CANCELADA" });
check("B no puede modificar reserva de A -> 404", r.status === 404, JSON.stringify(r.data));

r = await api(tokenA, "DELETE", `/trips/${tripId}`);
check("DELETE viaje", r.status === 200, JSON.stringify(r.data));

console.log(failures ? `\n${failures} pruebas fallaron` : "\nTodas las pruebas pasaron");
process.exit(failures ? 1 : 0);
