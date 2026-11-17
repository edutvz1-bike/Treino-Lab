function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function firstValue(record, paths) {
  for (const path of paths) {
    let value = record;
    for (const key of path.split(".")) value = value?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function timestamp(value) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function onRequestGet({ env }) {
  if (!env.HEALTH_KV) return json({ error: "missing_config" }, 500);
  const [stored, lastSync] = await Promise.all([
    env.HEALTH_KV.get("google-health:data"),
    env.HEALTH_KV.get("google-health:last-sync")
  ]);
  if (!stored) return json({ available: false, lastSync: lastSync ? JSON.parse(lastSync) : null });
  try {
    const data = JSON.parse(stored);
    const sleep = Array.isArray(data.sleep) ? data.sleep : [];
    const heartRate = Array.isArray(data.heartRate) ? data.heartRate : [];

    // A API entrega cada ponto de sono dentro de record.sleep.
    // Usa a sessão mais recente e, quando disponível, o resumo oficial do Google.
    const sessions = sleep.map(record => {
      const session = record?.sleep || record;
      const interval = session?.interval || {};
      const start = timestamp(interval.startTime || interval.start_time || session.startTime || session.start_time);
      const end = timestamp(interval.endTime || interval.end_time || session.endTime || session.end_time);
      const summaryMinutes = Number(session?.summary?.minutesAsleep ?? session?.summary?.minutes_asleep);
      let stageMinutes = 0;
      for (const stage of Array.isArray(session?.stages) ? session.stages : []) {
        const type = String(stage?.type || "").toUpperCase();
        if (!["DEEP", "LIGHT", "REM", "ASLEEP"].includes(type)) continue;
        const stageStart = timestamp(stage.startTime || stage.start_time);
        const stageEnd = timestamp(stage.endTime || stage.end_time);
        if (stageStart && stageEnd && stageEnd > stageStart) {
          stageMinutes += (stageEnd - stageStart) / 60000;
        }
      }
      const duration = Number.isFinite(summaryMinutes) && summaryMinutes > 0
        ? summaryMinutes
        : stageMinutes > 0
          ? stageMinutes
          : start && end && end > start
            ? (end - start) / 60000
            : null;
      return { start, end, duration };
    }).filter(item => item.duration > 0);

    sessions.sort((a, b) => (b.end || b.start || 0) - (a.end || a.start || 0));
    const latestSleep = sessions[0] || null;
    const sleepMinutes = latestSleep ? Math.round(latestSleep.duration) : null;

    const bpmValues = heartRate.map(record => Number(firstValue(record, [
      "heartRate.beatsPerMinute", "beatsPerMinute", "value.beatsPerMinute"
    ]))).filter(value => Number.isFinite(value) && value > 0 && value < 260);
    const averageHeartRate = bpmValues.length
      ? Math.round(bpmValues.reduce((sum, value) => sum + value, 0) / bpmValues.length)
      : null;

    return json({
      available: true,
      syncedAt: data.syncedAt || null,
      sleepRecords: sleep.length,
      sleepMinutes: sleepMinutes > 0 ? Math.round(sleepMinutes) : null,
      averageHeartRate,
      heartRateRecords: heartRate.length
    });
  } catch {
    return json({ error: "invalid_stored_data" }, 500);
  }
}
