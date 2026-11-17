import { garminToken, garminGet, isCycling, metric } from "../lib/garmin.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}


function localDateKey(date = new Date()) {
  return new Date(date.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function weekStartKey(dateKey) {
  const date = new Date(dateKey + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "duração não informada";
  const minutes = Math.round(seconds / 60);
  return Math.floor(minutes / 60) + "h" + String(minutes % 60).padStart(2, "0") + "min";
}

async function loadTrainingContext(env) {
  const today = localDateKey();
  const monday = weekStartKey(today);
  const context = { today, monday, activities: [], pmc: null, recovery: null, notes: [] };

  if (env.HEALTH_KV) {
    try {
      const storedHealth = await env.HEALTH_KV.get("google-health:data");
      if (storedHealth) {
        const health = JSON.parse(storedHealth);
        const samples = Array.isArray(health.heartRateVariability) ? health.heartRateVariability : [];
        const daily = Array.isArray(health.dailyHeartRateVariability) ? health.dailyHeartRateVariability : [];
        const latest = (records, paths) => records.map(record => {
          let value = null;
          for (const path of paths) {
            value = path.split(".").reduce((obj, key) => obj?.[key], record);
            if (value !== null && value !== undefined) break;
          }
          const time = record?.heartRateVariability?.sampleTime?.physicalTime || record?.sampleTime?.physicalTime ||
            record?.dailyHeartRateVariability?.date?.year && record?.dailyHeartRateVariability?.date;
          const date = typeof time === "string" ? Date.parse(time) : time?.year ? Date.UTC(time.year, (time.month || 1) - 1, time.day || 1) : 0;
          return { value: Number(value), date };
        }).filter(item => Number.isFinite(item.value) && item.value > 0 && item.value <= 250).sort((a,b) => b.date-a.date)[0] || null;
        const sample = latest(samples, ["heartRateVariability.rootMeanSquareOfSuccessiveDifferencesMilliseconds", "rootMeanSquareOfSuccessiveDifferencesMilliseconds"]);
        const day = latest(daily, ["dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds", "averageHeartRateVariabilityMilliseconds", "dailyHeartRateVariability.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds"]);
        const chosen = sample || day;
        const sleep = Array.isArray(health.sleep) ? health.sleep : [];
        const lastSleep = sleep.map(record => {
          const session = record?.sleep || record;
          const minutes = Number(session?.summary?.minutesAsleep ?? session?.summary?.minutes_asleep);
          return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
        }).filter(Boolean).at(-1) || null;
        context.recovery = {
          hrv: chosen ? Math.round(chosen.value * 10) / 10 : null,
          sleepMinutes: lastSleep,
          syncedAt: health.syncedAt || null
        };
      }
    } catch (error) {
      context.notes.push("Não foi possível ler os dados de recuperação do Apple Saúde: " + (error?.message || "erro de leitura") + ".");
    }
  }

  if (env.GARMIN_PERSONAL_API_KEY) {
    try {
      const token = await garminToken(env);
      const query = new URLSearchParams({ start: "0", limit: "100", startDate: monday, endDate: today });
      const payload = await garminGet(token, "/activitylist-service/activities/search/activities?" + query.toString());
      const records = Array.isArray(payload) ? payload : Array.isArray(payload?.activities) ? payload.activities : Array.isArray(payload?.data) ? payload.data : null;
      if (!records) throw new Error("formato inesperado da lista de atividades");
      context.activities = records.filter(isCycling).map(activity => {
        const rawDate = activity.startTimeLocal || activity.startTimeGMT || activity.startTime || activity.date;
        return {
          date: rawDate ? String(rawDate).slice(0, 10) : "data não informada",
          name: String(activity.activityName || activity.name || "Pedal"),
          durationSec: metric(activity, ["duration", "durationInSeconds", "movingDuration", "movingDurationInSeconds", "elapsedDuration", "elapsedDurationInSeconds", "totalDurationInSeconds"]),
          distanceKm: (() => { const n = metric(activity, ["distance", "distanceInMeters", "totalDistance", "totalDistanceInMeters"]); return n == null ? null : Math.round(n / 100) / 10; })(),
          tss: metric(activity, ["trainingStressScore", "trainingLoad", "tss"]),
          normalizedPower: metric(activity, ["normalizedPower", "normPower", "normalisedPower", "normalized_power"]),
          avgPower: metric(activity, ["averagePower", "avgPower"]),
          avgHr: metric(activity, ["averageHR", "averageHeartRate", "avgHeartRate"])
        };
      }).filter(activity => activity.date >= monday && activity.date <= today).sort((a, b) => a.date.localeCompare(b.date));
      if (!context.activities.length) context.notes.push("A Garmin não retornou pedais concluídos nesta semana.");
    } catch (error) {
      context.notes.push("Não foi possível consultar a Garmin nesta conversa: " + (error?.message || "erro de integração") + ".");
    }
  } else {
    context.notes.push("A integração Garmin não está configurada no servidor.");
  }

  if (env.INTERVALS_API_KEY) {
    try {
      const oldest = new Date(today + "T12:00:00Z");
      oldest.setUTCDate(oldest.getUTCDate() - 14);
      const url = new URL("https://intervals.icu/api/v1/athlete/0/wellness");
      url.searchParams.set("oldest", oldest.toISOString().slice(0, 10));
      url.searchParams.set("newest", today);
      const response = await fetch(url, {
        headers: { authorization: "Basic " + btoa("API_KEY:" + env.INTERVALS_API_KEY), accept: "application/json" }
      });
      if (!response.ok) throw new Error("Intervals.icu respondeu HTTP " + response.status);
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("formato inesperado dos dados de condicionamento");
      const points = rows.map(row => {
        const ctl = Number(row.ctl ?? row.ctLoad ?? row.ctlLoad);
        const atl = Number(row.atl ?? row.atlLoad);
        const date = row.id || row.date || row.day;
        return date && Number.isFinite(ctl) && Number.isFinite(atl)
          ? { date: String(date).slice(0, 10), ctl: Math.round(ctl * 10) / 10, atl: Math.round(atl * 10) / 10, tsb: Math.round((ctl - atl) * 10) / 10 }
          : null;
      }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
      context.pmc = points.slice(-8);
      if (!context.pmc.length) context.notes.push("O Intervals.icu não retornou CTL/ATL/TSB recentes.");
    } catch (error) {
      context.notes.push("Não foi possível consultar o condicionamento no Intervals.icu: " + (error?.message || "erro de integração") + ".");
    }
  } else {
    context.notes.push("A integração Intervals.icu não está configurada no servidor.");
  }

  return context;
}

function trainingContextText(context) {
  const lines = [
    "DADOS ATUAIS DO CICLISTA — consultados automaticamente pelo servidor para esta conversa.",
    "Data local considerada: " + context.today + ". Semana: " + context.monday + " até " + context.today + ".",
    "PEDAIS CONCLUÍDOS NA SEMANA:"
  ];
  if (context.activities.length) {
    for (const a of context.activities) {
      const values = [
        a.date + " — " + a.name,
        "duração: " + formatDuration(a.durationSec),
        a.distanceKm == null ? null : "distância: " + a.distanceKm + " km",
        a.tss == null ? null : "TSS/carga: " + a.tss,
        a.normalizedPower == null ? null : "NP: " + a.normalizedPower + " W",
        a.avgPower == null ? null : "potência média: " + a.avgPower + " W",
        a.avgHr == null ? null : "FC média: " + a.avgHr + " bpm"
      ].filter(Boolean);
      lines.push("- " + values.join("; "));
    }
  } else {
    lines.push("- Nenhuma atividade concluída foi recebida da Garmin nesta semana.");
  }
  lines.push("RECUPERAÇÃO E SAÚDE (Apple Saúde via Google Health):");
  if (context.recovery) {
    lines.push("- HRV mais recente (RMSSD quando disponível): " + (context.recovery.hrv == null ? "indisponível" : context.recovery.hrv + " ms"));
    lines.push("- Sono importado: " + (context.recovery.sleepMinutes == null ? "indisponível" : formatDuration(context.recovery.sleepMinutes * 60)));
    lines.push("- Sincronização: " + (context.recovery.syncedAt || "data não informada"));
  } else {
    lines.push("- Dados de recuperação do Apple Saúde ainda não disponíveis.");
  }
  lines.push("CONDICIONAMENTO (Intervals.icu), últimos dias:");
  if (context.pmc?.length) {
    for (const p of context.pmc) lines.push("- " + p.date + ": CTL " + p.ctl + ", ATL " + p.atl + ", TSB " + p.tsb);
  } else {
    lines.push("- Dados de CTL/ATL/TSB indisponíveis.");
  }
  if (context.notes.length) lines.push("LIMITAÇÕES DA CONSULTA:", ...context.notes.map(note => "- " + note));
  lines.push("Use esses dados como contexto real. Não confunda potência média com Normalized Power. Não invente campos ausentes. Os dados representam atividades concluídas, não necessariamente treinos planejados. Ao recomendar o treino de amanhã, considere a sequência e carga recente, CTL/ATL/TSB e descanso; se faltarem dados importantes (sensação de recuperação, dor, sono ou disponibilidade), pergunte ou deixe a recomendação condicional.");
  return lines.join("\n");
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "invalid_origin" }, 403);
  if (!env.GEMINI_API_KEY) return json({ error: "gemini_not_configured", message: "A chave GEMINI_API_KEY não está configurada no Cloudflare." }, 500);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 24000) return json({ error: "request_too_large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  if (!messages.length || messages.some(m =>
    !m || !["user", "model"].includes(m.role) || typeof m.text !== "string" ||
    !m.text.trim() || m.text.length > 4000
  )) return json({ error: "invalid_messages", message: "Envie uma conversa válida, com mensagens de até 4.000 caracteres." }, 400);

  const contents = messages.map(m => ({
    role: m.role,
    parts: [{ text: m.text.trim() }]
  }));

  const trainingContext = await loadTrainingContext(env);
  const athleteContext = trainingContextText(trainingContext);

  let response;
  try {
    response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "Você é o Coach IA do Treino Lab, um assistente especializado em ciclismo e treinamento esportivo. Converse em português brasileiro, com tom amigável, claro, objetivo e motivador. Ajude o ciclista a compreender conceitos de treino, estruturar objetivos, interpretar métricas que ele fornecer (FTP, potência, frequência cardíaca, TSS, CTL, ATL, TSB, volume e percepção de esforço) e refletir sobre consistência e recuperação. Não invente dados do usuário. Você recebe abaixo um contexto atualizado consultado automaticamente nas integrações Garmin e Intervals.icu; use-o quando relevante e seja transparente quando alguma fonte estiver indisponível. Quando faltarem dados, pergunte o necessário e explique limitações. Não diagnostique doenças, não prescreva medicamentos e não substitua profissionais de saúde. Para dor, tontura, dor no peito ou sintomas incomuns, oriente interromper o exercício e procurar avaliação médica adequada. Não recomende aumentos bruscos de carga. Ao sugerir treino, apresente objetivo, duração e intensidade de forma prudente, deixando claro quando for uma sugestão geral.\n\n" + athleteContext
            }]
          },
          contents,
          generationConfig: { temperature: 0.65, maxOutputTokens: 1800 }
        })
      }
    );
  } catch {
    return json({ error: "gemini_unavailable", message: "Não foi possível conectar ao Gemini. Tente novamente." }, 502);
  }

  if (!response.ok) {
    console.error("Gemini Coach IA HTTP", response.status);
    return json({
      error: "gemini_http_" + response.status,
      message: response.status === 429
        ? "O limite de solicitações do Gemini foi atingido. Aguarde um pouco e tente novamente."
        : "O Gemini não conseguiu responder agora. Verifique a chave GEMINI_API_KEY, o acesso ao modelo e a cota no Google AI Studio."
    }, 502);
  }

  let result;
  try { result = await response.json(); } catch { return json({ error: "invalid_gemini_response" }, 502); }
  const reply = result?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim();
  if (!reply) return json({ error: "empty_response", message: "O Gemini retornou uma resposta vazia. Tente reformular sua pergunta." }, 502);
  return json({ reply });
}
