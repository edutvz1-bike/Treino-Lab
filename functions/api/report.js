function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

export async function onRequestGet({ request, env }) {
  const name = new URL(request.url).searchParams.get("name") || "";

  // Apenas ficheiros diários com o formato esperado.
  if (!/^relatorio_\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
    return json({ error: "invalid_report_name" }, 400);
  }

  if (!env.GITHUB_TOKEN) {
    return json({ error: "server_config" }, 500);
  }

  const url =
    `https://api.github.com/repos/edutvz1-bike/agente-treino-ia/contents/relatorios/${name}?ref=main`;

  let response;

  try {
    response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Pedal-Coach"
      }
    });
  } catch {
    return json({ error: "github_unavailable" }, 502);
  }

  if (!response.ok) {
    console.error("GitHub report API status:", response.status);
    return json({ error: "report_unavailable" }, 502);
  }

  const file = await response.json();

  if (file.encoding !== "base64" || !file.content) {
    return json({ error: "invalid_report_content" }, 502);
  }

  try {
    const binary = atob(file.content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    const content = new TextDecoder().decode(bytes);

    return json({ name, content });
  } catch {
    return json({ error: "invalid_report_content" }, 502);
  }
}
