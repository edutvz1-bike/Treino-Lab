const COOKIE_NAME = "treino_lab_session";
const SESSION_SECONDS = 60 * 60 * 12;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }
  });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

async function verifySession(token, secret) {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const payloadBytes = decodeBase64Url(parts[0]);
    const signature = decodeBase64Url(parts[1]);
    const valid = await crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(parts[0]));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    return Number.isFinite(payload.exp) && payload.exp > Math.floor(Date.now() / 1000) && typeof payload.email === "string";
  } catch { return false; }
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) return item.slice(index + 1).trim();
  }
  return "";
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return next();
  if (url.pathname === "/api/login" && request.method === "POST") return next();
  if (url.pathname === "/api/logout" && request.method === "POST") {
    const valid = await verifySession(getCookie(request, COOKIE_NAME), env.APP_SESSION_SECRET);
    if (!valid) return json({ error: "unauthorized", message: "Faça login para continuar." }, 401);
    return next();
  }
  const valid = await verifySession(getCookie(request, COOKIE_NAME), env.APP_SESSION_SECRET);
  if (!valid) return json({ error: "unauthorized", message: "Sessão expirada. Entre novamente." }, 401);
  return next();
}
