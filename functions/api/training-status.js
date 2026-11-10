import { json, garminToken, garminGet, errorResponse } from "../lib/garmin.js";

// A rota de Training Status não faz parte do conjunto público documentado
// da Personal API. Este caminho é experimental e pode deixar de funcionar.
export async function onRequestGet({ env }) {
  try {
    const token = await garminToken(env);
    const date = new Date().toISOString().slice(0, 10);
    const payload = await garminGet(
      token,
      `/gc-api/metrics-service/metrics/trainingstatus/daily/${date}`
    );

    const devices = payload?.latestTrainingStatusData;
    const records = devices && typeof devices === "object"
      ? Object.values(devices).filter(item => item && typeof item === "object")
      : [];

    const latest = records
      .filter(item => typeof item.trainingStatusFeedbackPhrase === "string" && item.trainingStatusFeedbackPhrase.trim())
      .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))[0];

    if (!latest) {
      return json({
        available: false,
        calendarDate: date,
        message: "A Garmin respondeu, mas não trouxe uma descrição de Training Status para esta data."
      });
    }

    return json({
      available: true,
      statusLabel: latest.trainingStatusFeedbackPhrase.trim(),
      calendarDate: latest.calendarDate || date,
      sinceDate: latest.sinceDate || null,
      message: "Descrição de status recebida diretamente da Garmin Connect."
    });
  } catch (error) {
    if (error?.status === 404) {
      return json({
        available: false,
        message: "A Garmin não disponibilizou esta consulta de Training Status para a integração."
      });
    }
    return errorResponse(error);
  }
}
