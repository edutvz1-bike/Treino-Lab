function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}
export async function onRequestGet({ request }) {
  const cookie = request.headers.get("Cookie") || "";
  const entry = cookie.split(";").map(v => v.trim()).find(v => v.startsWith("treino_lab_session="));
  if (!entry) return json({ authenticated: false }, 401);
  const token = entry.slice("treino_lab_session=".length);
  const payloadPart = token.split(".")[0];
  try {
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return json({ authenticated: true, user: { email: payload.email, name: "Ciclista" } });
  } catch { return json({ authenticated: false }, 401); }
}
