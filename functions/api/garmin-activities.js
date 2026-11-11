import { json, garminToken, garminGet, isCycling, metric, errorResponse } from "../lib/garmin.js";

const HISTORY_START = "2026-11-01";
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function dateKey(activity) {
  const raw = activity?.startTimeLocal || activity?.startTimeGMT || activity?.startTime || activity?.date;
  if (!raw) return null;
  const value = String(raw);
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function normalizeActivity(activity) {
  const distance = metric(activity, ["distance", "distanceInMeters", "totalDistance", "totalDistanceInMeters"]);
  const duration = metric(activity, ["duration", "durationInSeconds", "movingDuration", "movingDurationInSeconds", "elapsedDuration", "elapsedDurationInSeconds", "totalDurationInSeconds"]);
  const speed = metric(activity, ["averageSpeed", "avgSpeed", "averageSpeedInMetersPerSecond"]);
  const maxSpeed = metric(activity, ["maxSpeed", "maximumSpeed"]);
  const activityType = activity?.activityType?.typeKey || activity?.activityType?.typeName || activity?.activityTypeName || "Ciclismo";
  return {
    id: String(activity.activityId || activity.id || ""),
    date: dateKey(activity),
    name: String(activity.activityName || activity.name || "Pedal"),
    type: String(activityType),
    distanceKm: distance == null ? null : Math.round(distance / 100) / 10,
    durationSec: duration == null ? null : Math.round(duration),
    elevationGainM: metric(activity, ["elevationGain", "totalElevationGain", "elevationGainInMeters"]),
    avgSpeedKmh: speed == null ? null : Math.round(speed * (speed < 35 ? 3.6 : 1) * 10) / 10,
    maxSpeedKmh: maxSpeed == null ? null : Math.round(maxSpeed * (maxSpeed < 35 ? 3.6 : 1) * 10) / 10,
    avgHr: metric(activity, ["averageHR", "averageHeartRate", "avgHeartRate"]),
    maxHr: metric(activity, ["maxHR", "maximumHeartRate", "maxHeartRate"]),
    avgPower: metric(activity, ["averagePower", "avgPower"]),
    maxPower: metric(activity, ["maxPower", "maximumPower"]),
    calories: metric(activity, ["calories", "totalCalories"]),
    trainingLoad: metric(activity, ["trainingStressScore", "trainingLoad", "tss"])
  };
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const requestedStart = url.searchParams.get("startDate") || HISTORY_START;
  const endDate = new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedStart) || requestedStart < HISTORY_START || requestedStart > endDate) {
    return json({ error: "invalid_date", message: "A data inicial deve ser igual ou posterior a 01/11/2026." }, 400);
  }

  try {
    const token = await garminToken(env);
    const all = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({
        start: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE),
        startDate: requestedStart,
        endDate
      });
      const payload = await garminGet(token, "/activitylist-service/activities/search/activities?" + query.toString());
      const records = Array.isArray(payload) ? payload : Array.isArray(payload?.activities) ? payload.activities : Array.isArray(payload?.data) ? payload.data : null;
      if (!records) return json({ error: "invalid_garmin_response", message: "A Garmin retornou uma lista de atividades em formato inesperado." }, 502);
      all.push(...records);
      if (records.length < PAGE_SIZE) break;
    }

    const activities = all
      .filter(isCycling)
      .map(normalizeActivity)
      .filter(a => a.id && a.date && a.date >= requestedStart && a.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

    return json({
      activities,
      startDate: requestedStart,
      endDate,
      sourceActivityCount: all.length,
      cyclingActivityCount: activities.length,
      truncated: all.length >= PAGE_SIZE * MAX_PAGES
    });
  } catch (error) {
    return errorResponse(error);
  }
}
