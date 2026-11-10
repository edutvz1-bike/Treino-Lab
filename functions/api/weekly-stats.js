import { json, garminToken, garminGet, isCycling, metric, errorResponse } from "../lib/garmin.js";

function sumKnown(values) {
  return values.some(value => value !== null) ? values.reduce((sum, value) => sum + (value ?? 0), 0) : null;
}

export async function onRequestGet({ env }) {
  const now = new Date();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);
  const startDate = monday.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  try {
    const token = await garminToken(env);
    const query = new URLSearchParams({ start: "0", limit: "100", startDate, endDate });
    const payload = await garminGet(token, `/activitylist-service/activities/search/activities?${query.toString()}`);
    const activities = Array.isArray(payload) ? payload : Array.isArray(payload?.activities) ? payload.activities : Array.isArray(payload?.data) ? payload.data : null;
    if (!activities) return json({ error: "invalid_garmin_response", message: "A Garmin retornou uma lista de atividades em formato inesperado." }, 502);

    const rides = activities.filter(isCycling);
    const tss = sumKnown(rides.map(a => metric(a, ["trainingStressScore", "trainingLoad", "tss"])));
    const distanceMeters = sumKnown(rides.map(a => metric(a, ["distance", "distanceInMeters", "totalDistance", "totalDistanceInMeters"])));
    const seconds = sumKnown(rides.map(a => metric(a, ["duration", "durationInSeconds", "movingDuration", "movingDurationInSeconds", "elapsedDuration", "elapsedDurationInSeconds", "totalDurationInSeconds"])));
    const formatDate = date => date.toLocaleDateString("pt-BR", { timeZone: "UTC", day: "2-digit", month: "2-digit", year: "numeric" });
    const missing = [];
    if (tss === null) missing.push("TSS");
    if (distanceMeters === null) missing.push("distância");
    if (seconds === null) missing.push("duração");

    return json({
      periodLabel: `Semana de ${formatDate(monday)} a ${formatDate(now)}`,
      sourceActivityCount: activities.length,
      sessions: rides.length,
      tss: tss === null ? null : Math.round(tss * 10) / 10,
      distanceKm: distanceMeters === null ? null : Math.round(distanceMeters / 100) / 10,
      hours: seconds === null ? null : Math.round(seconds / 360) / 10,
      message: rides.length === 0
        ? `Nenhum pedal de ciclismo foi encontrado na Garmin entre ${startDate} e ${endDate}.`
        : missing.length
          ? `A Garmin não forneceu ${missing.join(", ")} diretamente para esta semana.`
          : ""
    });
  } catch (error) {
    return errorResponse(error);
  }
}
