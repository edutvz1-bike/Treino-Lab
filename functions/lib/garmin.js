const BASE = "https://personal.connectapi.garmin.com";

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

export async function garminToken(env) {
  const key = String(env.GARMIN_PERSONAL_API_KEY || "").trim();
  if (!key) throw Object.assign(new Error("A variável secreta GARMIN_PERSONAL_API_KEY não está configurada no Cloudflare."), { code: "garmin_not_configured" });
  const response = await fetch("https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token", {
    method: "POST",
    headers: { Authorization: "ApiKey " + key, Accept: "*/*" }
  });
  if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403
    ? "A Garmin recusou a chave pessoal. Confira GARMIN_PERSONAL_API_KEY no Cloudflare."
    : `A Garmin respondeu com HTTP ${response.status} ao solicitar o token.`), { code: response.status === 401 || response.status === 403 ? "garmin_auth_failed" : "garmin_http_error", status: response.status });
  const raw = await response.text();
  let payload = raw;
  try { payload = JSON.parse(raw); } catch {}
  const token = typeof payload === "string" ? payload.trim() : payload?.access_token || payload?.accessToken || payload?.token;
  if (!token) throw Object.assign(new Error("A Garmin não retornou um token de acesso reconhecido."), { code: "garmin_invalid_token" });
  return token;
}

export async function garminGet(token, path) {
  const response = await fetch(BASE + path, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" }
  });
  if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403
    ? "O token Garmin foi recusado. Confira se a chave pessoal está válida."
    : `A Garmin respondeu com HTTP ${response.status}.`), { code: response.status === 401 || response.status === 403 ? "garmin_auth_failed" : "garmin_http_error", status: response.status });
  return response.json();
}

export function isCycling(a) {
  const raw = [
    a?.activityType?.typeKey, a?.activityType?.type, a?.activityType?.parentTypeKey,
    a?.activityType?.typeName, a?.activityType, a?.sportType?.typeKey,
    a?.sportType?.type, a?.sport, a?.activityTypeName, a?.type,
    a?.activityName, a?.name
  ].map(v => typeof v === "string" ? v : "").join(" ").toLowerCase().replace(/[ _-]/g, "");
  return /cycling|biking|mountainbike|gravel|virtualride|indoorcycling|roadbike|roadcycling|cyclocross|bicycle/.test(raw);
}

export function metric(a, keys) {
  const sources = [a, a?.activitySummary, a?.summary, a?.activityDetails, a?.activity];
  for (const source of sources) {
    for (const key of keys) {
      const v = source?.[key];
      if (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v))) return Number(v);
    }
  }
  return null;
}

export function errorResponse(error) {
  const code = error?.code || "garmin_unavailable";
  const status = code === "garmin_not_configured" ? 500 : 502;
  return json({ error: code, message: error?.message || "Não foi possível conectar à Garmin Connect." }, status);
}
