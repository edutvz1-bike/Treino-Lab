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

    const intervals = sleep.map(record => {
      const start = timestamp(firstValue(record, ["startTime", "start_time", "sleep.interval.start_time.physical_time", "sleep.interval.start_time"]));
      const end = timestamp(firstValue(record, ["endTime", "end_time", "sleep.interval.end_time.physical_time", "sleep.interval.end_time"]));
      const type = String(firstValue(record, ["type", "sleep.type", "sleep.stage"]) || "").toUpperCase();
      return { start, end, type };
    }).filter(item => item.start && item.end && item.end > item.start);

    const stages = intervals.filter(item => /DEEP|LIGHT|REM|CORE/.test(item.type));
    const sleepIntervals = stages.length ? stages : intervals;
    const sleepMinutes = sleepIntervals.reduce((total, item) => total + (item.end - item.start) / 60000, 0);

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
