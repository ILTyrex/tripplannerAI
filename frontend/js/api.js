// Canal 1 · Operaciones de negocio: Frontend -> API Gateway (JWT Cognito) -> Lambda -> DynamoDB.
import { getIdToken } from "./auth.js";

const cfg = window.TRIPPLANNER_CONFIG;

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, body) {
  const token = await getIdToken();
  if (!token) throw new ApiError("Tu sesión expiró. Inicia sesión de nuevo.", 401, "UNAUTHORIZED");
  let res;
  try {
    res = await fetch(cfg.apiUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("No hay conexión con el servidor.", 0, "NETWORK");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || (res.status === 429 ? "Demasiadas solicitudes, intenta en un momento." : "No se pudo completar la operación.");
    throw new ApiError(message, res.status, data?.error?.code);
  }
  return data;
}

const enc = encodeURIComponent;
export const api = {
  me: () => request("GET", "/me"),
  updateMe: (body) => request("PUT", "/me", body),
  preferences: () => request("GET", "/preferences"),
  savePreferences: (body) => request("PUT", "/preferences", body),
  trips: (status) => request("GET", "/trips" + (status ? `?status=${enc(status)}` : "")),
  trip: (id) => request("GET", `/trips/${enc(id)}`),
  createTrip: (body) => request("POST", "/trips", body),
  updateTrip: (id, body) => request("PUT", `/trips/${enc(id)}`, body),
  deleteTrip: (id) => request("DELETE", `/trips/${enc(id)}`),
  itinerary: (id) => request("GET", `/trips/${enc(id)}/itinerary`),
  createItinerary: (id, body) => request("POST", `/trips/${enc(id)}/itinerary`, body),
  updateItinerary: (id, body) => request("PUT", `/trips/${enc(id)}/itinerary`, body),
  reservations: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request("GET", "/reservations" + (q ? `?${q}` : ""));
  },
  createReservation: (body) => request("POST", "/reservations", body),
  updateReservation: (id, body) => request("PUT", `/reservations/${enc(id)}`, body),
};
