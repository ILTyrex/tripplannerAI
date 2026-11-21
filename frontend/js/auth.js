// Autenticación con Amazon Cognito User Pools vía su API pública (sin SDK y sin secretos).
// El navegador solo conoce el ClientId público; los tokens JWT protegen API Gateway y AgentCore.
const cfg = window.TRIPPLANNER_CONFIG;
const KEY = "tp.auth";

async function cognito(target, body) {
  const res = await fetch(`https://cognito-idp.${cfg.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const type = (data.__type || "").split("#").pop();
    const messages = {
      NotAuthorizedException: "Correo o contraseña incorrectos.",
      UserNotFoundException: "Correo o contraseña incorrectos.",
      UsernameExistsException: "Ya existe una cuenta con ese correo. Inicia sesión.",
      InvalidPasswordException: "La contraseña no cumple la política (mínimo 8 caracteres, minúsculas y números).",
      InvalidParameterException: "Revisa los datos ingresados.",
      TooManyRequestsException: "Demasiados intentos. Espera un momento.",
    };
    throw new Error(messages[type] || data.message || "No se pudo completar la autenticación.");
  }
  return data;
}

function decode(token) {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch {
    return {};
  }
}

function save(result, previous = {}) {
  const session = {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken || previous.refreshToken,
    expiresAt: Date.now() + (result.ExpiresIn || 3600) * 1000,
  };
  try { localStorage.setItem(KEY, JSON.stringify(session)); } catch {}
  return session;
}

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
}

export async function signIn(email, password) {
  const data = await cognito("InitiateAuth", {
    ClientId: cfg.userPoolClientId,
    AuthFlow: "USER_PASSWORD_AUTH",
    AuthParameters: { USERNAME: email.trim().toLowerCase(), PASSWORD: password },
  });
  return save(data.AuthenticationResult);
}

export async function signUp(name, email, password) {
  await cognito("SignUp", {
    ClientId: cfg.userPoolClientId,
    Username: email.trim().toLowerCase(),
    Password: password,
    UserAttributes: [
      { Name: "email", Value: email.trim().toLowerCase() },
      { Name: "name", Value: name.trim() },
    ],
  });
  return signIn(email, password);
}

export function signOut() {
  try { localStorage.removeItem(KEY); } catch {}
}

export function currentUser() {
  const s = load();
  if (!s) return null;
  const claims = decode(s.idToken || "");
  return { sub: claims.sub, email: claims.email, name: claims.name || (claims.email || "").split("@")[0] };
}

// ID token (incluye email y nombre) para API Gateway; access token para AgentCore (valida client_id).
export async function getIdToken() {
  return (await getSession())?.idToken || null;
}
export async function getAccessToken() {
  return (await getSession())?.accessToken || null;
}

let refreshing = null;
async function getSession() {
  const s = load();
  if (!s) return null;
  if (Date.now() < s.expiresAt - 60_000) return s;
  if (!s.refreshToken) return null;
  refreshing ||= cognito("InitiateAuth", {
    ClientId: cfg.userPoolClientId,
    AuthFlow: "REFRESH_TOKEN_AUTH",
    AuthParameters: { REFRESH_TOKEN: s.refreshToken },
  }).then((d) => save(d.AuthenticationResult, s)).finally(() => { refreshing = null; });
  try {
    return await refreshing;
  } catch {
    signOut();
    return null;
  }
}
