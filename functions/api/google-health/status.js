function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export async function onRequestGet({ env }) {
  if (!env.HEALTH_KV) return json({ connected: false, configured: false }, 500);
  const [credentials, lastSync] = await Promise.all([
    env.HEALTH_KV.get("google-health:credentials"),
    env.HEALTH_KV.get("google-health:last-sync")
  ]);
  let sync = null;
  if (lastSync) {
    try { sync = JSON.parse(lastSync); } catch {}
  }
  return json({ connected: Boolean(credentials), configured: true, lastSync: sync });
}
