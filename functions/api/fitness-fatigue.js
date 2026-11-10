function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export async function onRequestGet({ env }) {
  const apiKey = env.INTERVALS_API_KEY;
  if (!apiKey) return json({ error: "missing_api_key", message: "A integração com Intervals.icu não está configurada no servidor." }, 503);

  const newest = new Date();
  const oldest = new Date(newest);
  oldest.setUTCDate(oldest.getUTCDate() - 180);
  const date = value => value.toISOString().slice(0, 10);
  const url = new URL("https://intervals.icu/api/v1/athlete/0/wellness");
  url.searchParams.set("oldest", date(oldest));
  url.searchParams.set("newest", date(newest));

  try {
    const credentials = btoa("API_KEY:" + apiKey);
    const response = await fetch(url, {
      headers: { authorization: "Basic " + credentials, accept: "application/json" }
    });
    if (!response.ok) {
      return json({
        error: "intervals_request_failed",
        message: response.status === 401 || response.status === 403
          ? "A autenticação do Intervals.icu falhou. Confira a variável INTERVALS_API_KEY no Cloudflare."
          : "O Intervals.icu retornou um erro (" + response.status + ")."
      }, 502);
    }

    const records = await response.json();
    if (!Array.isArray(records)) return json({ error: "invalid_response", message: "O Intervals.icu retornou dados em formato inesperado." }, 502);

    const points = records.map(record => {
      const fitness = Number(record.ctl ?? record.ctLoad ?? record.ctlLoad);
      const fatigue = Number(record.atl ?? record.atlLoad);
      const day = record.id || record.date || record.day;
      if (!day || !Number.isFinite(fitness) || !Number.isFinite(fatigue)) return null;
      return {
        date: String(day).slice(0, 10),
        fitness: Math.round(fitness * 10) / 10,
        fatigue: Math.round(fatigue * 10) / 10,
        form: Math.round((fitness - fatigue) * 10) / 10
      };
    }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));

    return json({ points, source: "Intervals.icu", days: points.length });
  } catch {
    return json({ error: "intervals_unavailable", message: "Não foi possível consultar o Intervals.icu agora." }, 502);
  }
}
