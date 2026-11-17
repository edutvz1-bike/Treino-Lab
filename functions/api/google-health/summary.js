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

function hrvTimestamp(record, daily = false) {
  const value = daily
    ? firstValue(record, ["dailyHeartRateVariability.date", "date"])
    : firstValue(record, ["heartRateVariability.sampleTime.physicalTime", "sampleTime.physicalTime", "heartRateVariability.sampleTime", "sampleTime"]);
  if (value && typeof value === "object") return timestamp(value.physicalTime || value.date);
  return timestamp(value);
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
    const hrvSamples = Array.isArray(data.heartRateVariability) ? data.heartRateVariability : [];
    const dailyHrv = Array.isArray(data.dailyHeartRateVariability) ? data.dailyHeartRateVariability : [];

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
        if (stageStart && stageEnd && stageEnd > stageStart) stageMinutes += (stageEnd - stageStart) / 60000;
      }
      const duration = Number.isFinite(summaryMinutes) && summaryMinutes > 0
        ? summaryMinutes
        : stageMinutes > 0 ? stageMinutes
          : start && end && end > start ? (end - start) / 60000 : null;
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

    const sampleValues = hrvSamples.map(record => ({
      value: Number(firstValue(record, [
        "heartRateVariability.rootMeanSquareOfSuccessiveDifferencesMilliseconds",
        "rootMeanSquareOfSuccessiveDifferencesMilliseconds",
        "heartRateVariability.standardDeviationMilliseconds",
        "standardDeviationMilliseconds"
      ])),
      date: hrvTimestamp(record, false),
      metric: firstValue(record, [
        "heartRateVariability.rootMeanSquareOfSuccessiveDifferencesMilliseconds",
        "rootMeanSquareOfSuccessiveDifferencesMilliseconds"
      ]) != null ? "RMSSD" : "SDNN"
    })).filter(item => Number.isFinite(item.value) && item.value > 0 && item.value <= 250)
      .sort((a, b) => (b.date || 0) - (a.date || 0));

    const dailyValues = dailyHrv.map(record => ({
      value: Number(firstValue(record, [
        "dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds",
        "averageHeartRateVariabilityMilliseconds",
        "dailyHeartRateVariability.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds",
        "deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds"
      ])),
      date: hrvTimestamp(record, true),
      metric: firstValue(record, [
        "dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds",
        "averageHeartRateVariabilityMilliseconds"
      ]) != null ? "RMSSD médio diário" : "RMSSD no sono profundo"
    })).filter(item => Number.isFinite(item.value) && item.value > 0 && item.value <= 250)
      .sort((a, b) => (b.date || 0) - (a.date || 0));

    const latestHrv = sampleValues[0] || dailyValues[0] || null;

    return json({
      available: true,
      syncedAt: data.syncedAt || null,
      sleepRecords: sleep.length,
      sleepMinutes: sleepMinutes > 0 ? sleepMinutes : null,
      averageHeartRate,
      heartRateRecords: heartRate.length,
      hrvValue: latestHrv ? Math.round(latestHrv.value * 10) / 10 : null,
      hrvMetric: latestHrv?.metric || null,
      hrvDate: latestHrv?.date ? new Date(latestHrv.date).toISOString() : null,
      hrvRecords: hrvSamples.length,
      dailyHrvRecords: dailyHrv.length
    });
  } catch {
    return json({ error: "invalid_stored_data" }, 500);
  }
}
