function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function getAccessToken(env, refreshToken) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_HEALTH_CLIENT_ID,
      client_secret: env.GOOGLE_HEALTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error === "invalid_grant"
      ? "A autorização do Google expirou. Conecte novamente sua conta."
      : "Não foi possível renovar a autorização do Google.");
  }
  return data.access_token;
}

async function fetchDataType(accessToken, dataType, pageSize, maxPages) {
  const records = [];
  let pageToken = "";
  for (let page = 0; page < maxPages; page++) {
    const url = new URL("https://health.googleapis.com/v4/users/me/dataTypes/" + encodeURIComponent(dataType) + "/dataPoints");
    url.searchParams.set("pageSize", String(pageSize));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url.toString(), {
      headers: { Authorization: "Bearer " + accessToken }
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error("O Google Health não conseguiu entregar os dados de " + dataType + ".");
    }
    const batch = Array.isArray(payload.dataPoints) ? payload.dataPoints : [];
    records.push(...batch);
    pageToken = payload.nextPageToken || "";
    if (!pageToken || batch.length === 0) break;
  }
  return records;
}

export async function onRequestPost({ env }) {
  if (!env.HEALTH_KV || !env.GOOGLE_HEALTH_CLIENT_ID || !env.GOOGLE_HEALTH_CLIENT_SECRET) {
    return json({ error: "missing_config", message: "A integração Google Health não está configurada por completo." }, 500);
  }

  const stored = await env.HEALTH_KV.get("google-health:credentials");
  if (!stored) return json({ error: "not_connected", message: "Conecte sua conta Google Health antes de sincronizar." }, 400);

  try {
    const credentials = JSON.parse(stored);
    if (!credentials.refreshToken) throw new Error("A autorização do Google não está disponível. Conecte novamente.");
    const accessToken = await getAccessToken(env, credentials.refreshToken);

    const [sleep, heartRate, dailyRestingHeartRate, heartRateVariability, dailyHeartRateVariability] = await Promise.all([
      fetchDataType(accessToken, "sleep", 25, 8),
      fetchDataType(accessToken, "heart-rate", 1000, 4),
      fetchDataType(accessToken, "daily-resting-heart-rate", 100, 8),
      fetchDataType(accessToken, "heart-rate-variability", 100, 8),
      fetchDataType(accessToken, "daily-heart-rate-variability", 100, 8)
    ]);

    const result = {
      syncedAt: new Date().toISOString(),
      source: "Google Health / Apple Health",
      sleep,
      heartRate,
      dailyRestingHeartRate,
      heartRateVariability,
      dailyHeartRateVariability
    };
    await env.HEALTH_KV.put("google-health:last-sync", JSON.stringify({
      syncedAt: result.syncedAt,
      sleepRecords: sleep.length,
      heartRateRecords: heartRate.length,
      restingHeartRateRecords: dailyRestingHeartRate.length,
      hrvRecords: heartRateVariability.length,
      dailyHrvRecords: dailyHeartRateVariability.length
    }));
    await env.HEALTH_KV.put("google-health:data", JSON.stringify(result));

    return json({
      success: true,
      syncedAt: result.syncedAt,
      sleepRecords: sleep.length,
      heartRateRecords: heartRate.length,
      restingHeartRateRecords: dailyRestingHeartRate.length,
      hrvRecords: heartRateVariability.length,
      dailyHrvRecords: dailyHeartRateVariability.length
    });
  } catch (error) {
    return json({ error: "sync_failed", message: error.message || "Falha ao sincronizar os dados de saúde." }, 502);
  }
}
