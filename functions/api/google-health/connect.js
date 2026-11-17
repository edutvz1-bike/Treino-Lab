const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly"
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function onRequestGet({ request, env }) {
  if (!env.HEALTH_KV || !env.GOOGLE_HEALTH_CLIENT_ID) {
    return json({ error: "missing_config", message: "A integração Google Health ainda não está configurada por completo na Cloudflare." }, 500);
  }

  const state = randomState();
  await env.HEALTH_KV.put("google-health:oauth-state:" + state, JSON.stringify({
    createdAt: Date.now()
  }), { expirationTtl: 600 });

  const redirectUri = new URL("/api/google-health/callback", request.url).toString();
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.search = new URLSearchParams({
    client_id: env.GOOGLE_HEALTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  }).toString();

  return Response.redirect(authorize.toString(), 302);
}
