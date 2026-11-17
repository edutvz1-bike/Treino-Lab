function json(data) {
  return new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": "treino_lab_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" }
  });
}
export async function onRequestPost() {
  return json({ success: true });
}
