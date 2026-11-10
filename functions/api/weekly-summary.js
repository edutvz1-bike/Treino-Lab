import { json, garminToken, garminGet, isCycling, metric, errorResponse } from "../lib/garmin.js";

function sumKnown(values) {
  return values.some(value => value !== null)
    ? values.reduce((sum, value) => sum + (value ?? 0), 0)
    : null;
}

export async function onRequestGet({ env }) {
  const now = new Date();
  const currentMonday = new Date(now);
  currentMonday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  currentMonday.setUTCHours(0, 0, 0, 0);
  const firstMonday = new Date(currentMonday);
  firstMonday.setUTCDate(firstMonday.getUTCDate() - 21);
  const startDate = firstMonday.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  try {
    const token = await garminToken(env);
    const query = new URLSearchParams({ start: "0", limit: "200", startDate, endDate });
    const payload = await garminGet(token, `/activitylist-service/activities/search/activities?${query.toString()}`);
    const activities = Array.isArray(payload) ? payload : Array.isArray(payload?.activities) ? payload.activities : Array.isArray(payload?.data) ? payload.data : null;
    if (!activities) return json({ error: "invalid_garmin_response", message: "A Garmin retornou uma lista de atividades em formato inesperado." }, 502);

    const weeks = Array.from({ length: 4 }, (_, index) => {
      const start = new Date(firstMonday);
      start.setUTCDate(start.getUTCDate() + index * 7);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      if (index === 3) end.setTime(now.getTime());
      const startKey = start.toISOString().slice(0, 10);
      const endKey = end.toISOString().slice(0, 10);
      const rides = activities.filter(activity => {
        if (!isCycling(activity)) return false;
        const rawDate = activity.startTimeLocal || activity.startTimeGMT || activity.startTime || activity.date;
        if (!rawDate) return false;
        const day = String(rawDate).slice(0, 10);
        return day >= startKey && day <= endKey;
      });
      const tss = sumKnown(rides.map(a => metric(a, ["trainingStressScore", "trainingLoad", "tss"])));
      const meters = sumKnown(rides.map(a => metric(a, ["distance", "distanceInMeters", "totalDistance", "totalDistanceInMeters"])));
      const seconds = sumKnown(rides.map(a => metric(a, ["duration", "durationInSeconds", "movingDuration", "movingDurationInSeconds", "elapsedDuration", "elapsedDurationInSeconds", "totalDurationInSeconds"])));
      return {
        label: `${start.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit" })}–${end.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit" })}`,
        tss: tss === null ? null : Math.round(tss * 10) / 10,
        hours: seconds === null ? null : Math.round(seconds / 360) / 10,
        distanceKm: meters === null ? null : Math.round(meters / 100) / 10,
        sessions: rides.length
      };
    });

    return json({ weeks, startDate, endDate, sourceActivityCount: activities.length });
  } catch (error) {
    return errorResponse(error);
  }
}