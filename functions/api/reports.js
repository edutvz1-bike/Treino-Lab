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

export async function onRequestGet({ env }) {
  if (!env.GITHUB_TOKEN) {
    return json({ error: "server_config" }, 500);
  }

  const url =
    "https://api.github.com/repos/edutvz1-bike/agente-treino-ia/contents/relatorios?ref=main";

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
    console.error("GitHub reports API status:", response.status);
    return json({ error: "github_unavailable" }, 502);
  }

  const files = await response.json();

  if (!Array.isArray(files)) {
    return json({ error: "invalid_github_response" }, 502);
  }

  const reports = files
    .filter(file =>
      file.type === "file" &&
      /^relatorio_\d{4}-\d{2}-\d{2}\.md$/.test(file.name)
    )
    .map(file => ({
      name: file.name,
      date: file.name.match(/\d{4}-\d{2}-\d{2}/)[0]
    }))
    .sort((a, b) => b.date.localeCompare(a.date));

  return json({ reports });
}
