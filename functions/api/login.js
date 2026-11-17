const COOKIE_NAME = "treino_lab_session";
const SESSION_SECONDS = 60 * 60 * 12;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a));
  const right = new TextEncoder().encode(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "invalid_origin" }, 403);
  if (!env.APP_LOGIN_EMAIL || !env.APP_LOGIN_PASSWORD || !env.APP_SESSION_SECRET) {
    return json({ error: "auth_not_configured", message: "A autenticação ainda não foi configurada no Cloudflare." }, 503);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 3000) return json({ error: "invalid_request" }, 400);
    body = JSON.parse(raw);
  } catch { return json({ error: "invalid_request", message: "Solicitação inválida." }, 400); }

  if (!safeEqual(String(body.email || "").trim().toLowerCase(), env.APP_LOGIN_EMAIL.trim().toLowerCase()) ||
      !safeEqual(String(body.password || ""), env.APP_LOGIN_PASSWORD)) {
    return json({ error: "invalid_credentials", message: "E-mail ou senha incorretos." }, 401);
  }

  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    email: env.APP_LOGIN_EMAIL.trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS
  })));
  const signature = base64Url(await hmac(payload, env.APP_SESSION_SECRET));
  const cookie = COOKIE_NAME + "=" + payload + "." + signature + "; Path=/; Max-Age=" + SESSION_SECONDS + "; HttpOnly; Secure; SameSite=Lax";
  return json({ success: true, user: { email: env.APP_LOGIN_EMAIL.trim().toLowerCase(), name: "Ciclista" } }, 200, { "Set-Cookie": cookie });
}
