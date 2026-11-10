import { json, garminToken, garminGet, isCycling, metric, errorResponse } from "../lib/garmin.js";

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "invalid_origin" }, 403);
  if (!env.GEMINI_API_KEY) return json({ error: "gemini_not_configured", message: "A chave da IA não está configurada." }, 500);

  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const cache = caches.default;
    const rateKey = new Request(`${url.origin}/__internal/analyze-last-ride/${encodeURIComponent(ip)}`);
    if (await cache.match(rateKey)) return json({ error: "rate_limited", message: "Aguarde um minuto antes de solicitar outra análise." }, 429);
    await cache.put(rateKey, new Response("limited", { headers: { "Cache-Control": "public, max-age=60" } }));
  } catch {}

  let activity;
  let detail;
  try {
    const token = await garminToken(env);
    const query = new URLSearchParams({ start: "0", limit: "100" });
    const payload = await garminGet(token, `/activitylist-service/activities/search/activities?${query.toString()}`);
    const activities = Array.isArray(payload) ? payload : Array.isArray(payload?.activities) ? payload.activities : Array.isArray(payload?.data) ? payload.data : null;
    if (!activities) return json({ error: "invalid_garmin_response", message: "A Garmin retornou uma lista de atividades em formato inesperado." }, 502);
    const sorted = [...activities].sort((a, b) => {
      const dateA = Date.parse(a.startTimeLocal || a.startTimeGMT || a.startDate || 0) || 0;
      const dateB = Date.parse(b.startTimeLocal || b.startTimeGMT || b.startDate || 0) || 0;
      return dateB - dateA;
    });
    activity = sorted.find(isCycling);
    if (!activity) return json({ error: "no_recent_activity", message: "Não encontrei um pedal recente na Garmin Connect." }, 404);
    const id = activity.activityId ?? activity.activity_id ?? activity.id;
    if (id === undefined || id === null || !/^[0-9]+$/.test(String(id))) {
      return json({ error: "invalid_activity_id", message: "Não foi possível identificar o pedal mais recente na Garmin." }, 502);
    }
    detail = await garminGet(token, `/activity-service/activity/${encodeURIComponent(String(id))}`).catch(() => activity);
    if (!detail || typeof detail !== "object") detail = activity;
  } catch (error) {
    return errorResponse(error);
  }

  const merged = { ...activity, ...detail };
  const distanceMeters = metric(merged, ["distance", "distanceInMeters"]);
  const duration = metric(merged, ["movingDuration", "duration", "elapsedDuration"]);
  const averagePower = metric(merged, ["averagePower", "avgPower", "averagePowerInWatts"]);
  const maxPower = metric(merged, ["maxPower", "maxPowerInWatts"]);
  const averageHeartRate = metric(merged, ["averageHR", "averageHeartRate", "avgHeartRate"]);
  const maxHeartRate = metric(merged, ["maxHR", "maxHeartRate"]);
  const averageCadence = metric(merged, ["averageBikeCadence", "averageCadence", "avgCadence"]);
  const elevationGain = metric(merged, ["elevationGain", "totalElevationGain"]);
  const calories = metric(merged, [" calories", "calories"]);
  const cleanActivity = {
    id: String(merged.activityId ?? merged.activity_id ?? merged.id ?? ""),
    name: merged.activityName || merged.name || "Pedal recente",
    type: merged.activityType?.typeKey || merged.activityType?.type || merged.type || "Ciclismo",
    start_date_local: merged.startTimeLocal || merged.startTimeGMT || merged.startDate || null,
    distance: distanceMeters,
    moving_time: duration,
    elapsed_time: metric(merged, ["elapsedDuration", "duration"]),
    metrics: {
      averagePower,
      normalizedPower: metric(merged, ["normPower", "normalizedPower"]),
      maxPower,
      averageHeartRate,
      maxHeartRate,
      averageCadence,
      distanceMeters,
      movingSeconds: duration,
      elevationGain,
      calories,
      trainingLoad: metric(merged, ["trainingStressScore", "trainingLoad", "tss"]),
      intensity: metric(merged, ["intensityFactor", "intensity"]),
      streams: null
    }
  };

  const prompt = `
Você é treinador de ciclismo. Responda em português brasileiro, de forma direta, clara e útil. A análise deve caber em aproximadamente 120 a 180 palavras.

REGRAS:
- Não invente métricas, zonas, FTP, objetivos ou dados ausentes.
- Use apenas métricas reais fornecidas. Se faltarem dados, mencione isso em UMA frase curta, sem listar todos os campos ausentes.
- Não repita informações nem use introdução genérica.
- Não faça diagnóstico médico.
- Se os dados forem insuficientes para avaliar o treino, diga isso com clareza e recomende uma única verificação prática.

ATIVIDADE:
${JSON.stringify(cleanActivity, null, 2)}

Use exatamente esta estrutura, com títulos curtos:
### Resumo
Uma linha com os dados disponíveis mais importantes (distância, duração, potência e frequência cardíaca, quando existirem).

### Leitura do treinador
Duas ou três frases com a principal interpretação baseada nos dados.

### Atenção
Só inclua se houver algo relevante. Se não houver, omita a seção.

### Próximo passo
Uma recomendação prática e objetiva para o próximo pedal ou para verificar os dados.

Se uma métrica não estiver disponível, não exiba "null" nem invente um valor. Seja conciso e evite listas longas.
`;

  let aiResponse;
  try {
    aiResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.35, maxOutputTokens: 7000 } })
    });
  } catch {
    return json({ error: "ai_unavailable", message: "Não foi possível conectar ao serviço de análise por IA." }, 502);
  }
  if (!aiResponse.ok) return json({ error: "ai_error", message: `O serviço de IA respondeu com HTTP ${aiResponse.status}. Verifique a chave e a cota do Gemini.` }, 502);
  const aiData = await aiResponse.json();
  const analysis = aiData?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n").trim();
  if (!analysis) return json({ error: "empty_analysis", message: "A IA não retornou uma análise. Tente novamente." }, 502);
  return json({ activity: cleanActivity, analysis });
}
