function redirect(request, status) {
  const url = new URL("/", request.url);
  url.searchParams.set(status === "connected" ? "googleHealth" : "googleHealthError", status);
  return Response.redirect(url.toString(), 302);
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirect(request, "authorization_denied");
  if (!code || !state || !env.HEALTH_KV || !env.GOOGLE_HEALTH_CLIENT_ID || !env.GOOGLE_HEALTH_CLIENT_SECRET) {
    return redirect(request, "configuration_error");
  }

  const stateKey = "google-health:oauth-state:" + state;
  const storedState = await env.HEALTH_KV.get(stateKey);
  if (!storedState) return redirect(request, "invalid_state");
  await env.HEALTH_KV.delete(stateKey);

  let stateData;
  try { stateData = JSON.parse(storedState); } catch { return redirect(request, "invalid_state"); }
  if (!Number.isFinite(stateData.createdAt) || Date.now() - stateData.createdAt > 10 * 60 * 1000) {
    return redirect(request, "expired_state");
  }

  const redirectUri = new URL("/api/google-health/callback", request.url).toString();
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_HEALTH_CLIENT_ID,
    client_secret: env.GOOGLE_HEALTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code"
  });

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    const tokens = await response.json();
    if (!response.ok || !tokens.refresh_token) {
      // Não registra nem devolve tokens ao navegador.
      return redirect(request, "token_exchange_failed");
    }

    await env.HEALTH_KV.put("google-health:credentials", JSON.stringify({
      refreshToken: tokens.refresh_token,
      scope: tokens.scope || "",
      connectedAt: new Date().toISOString()
    }));
    await env.HEALTH_KV.delete("google-health:last-sync");
    return redirect(request, "connected");
  } catch {
    return redirect(request, "token_exchange_failed");
  }
}
