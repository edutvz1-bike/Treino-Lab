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

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "invalid_origin" }, 403);
  if (!env.GEMINI_API_KEY) return json({ error: "gemini_not_configured", message: "A chave GEMINI_API_KEY não está configurada no Cloudflare." }, 500);

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 24000) return json({ error: "request_too_large" }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  if (!messages.length || messages.some(m =>
    !m || !["user", "model"].includes(m.role) || typeof m.text !== "string" ||
    !m.text.trim() || m.text.length > 4000
  )) return json({ error: "invalid_messages", message: "Envie uma conversa válida, com mensagens de até 4.000 caracteres." }, 400);

  const contents = messages.map(m => ({
    role: m.role,
    parts: [{ text: m.text.trim() }]
  }));

  let response;
  try {
    response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "Você é o Coach IA do Treino Lab, um assistente especializado em ciclismo e treinamento esportivo. Converse em português brasileiro, com tom amigável, claro, objetivo e motivador. Ajude o ciclista a compreender conceitos de treino, estruturar objetivos, interpretar métricas que ele fornecer (FTP, potência, frequência cardíaca, TSS, CTL, ATL, TSB, volume e percepção de esforço) e refletir sobre consistência e recuperação. Não invente dados do usuário nem afirme que consultou o Intervals.icu, Garmin ou histórico: só use dados explicitamente fornecidos na conversa. Quando faltarem dados, pergunte o necessário e explique limitações. Não diagnostique doenças, não prescreva medicamentos e não substitua profissionais de saúde. Para dor, tontura, dor no peito ou sintomas incomuns, oriente interromper o exercício e procurar avaliação médica adequada. Não recomende aumentos bruscos de carga. Ao sugerir treino, apresente objetivo, duração e intensidade de forma prudente, deixando claro quando for uma sugestão geral."
            }]
          },
          contents,
          generationConfig: { temperature: 0.65, maxOutputTokens: 1800 }
        })
      }
    );
  } catch {
    return json({ error: "gemini_unavailable", message: "Não foi possível conectar ao Gemini. Tente novamente." }, 502);
  }

  if (!response.ok) {
    console.error("Gemini Coach IA HTTP", response.status);
    return json({
      error: "gemini_http_" + response.status,
      message: response.status === 429
        ? "O limite de solicitações do Gemini foi atingido. Aguarde um pouco e tente novamente."
        : "O Gemini não conseguiu responder agora. Verifique a chave GEMINI_API_KEY, o acesso ao modelo e a cota no Google AI Studio."
    }, 502);
  }

  let result;
  try { result = await response.json(); } catch { return json({ error: "invalid_gemini_response" }, 502); }
  const reply = result?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("\n").trim();
  if (!reply) return json({ error: "empty_response", message: "O Gemini retornou uma resposta vazia. Tente reformular sua pergunta." }, 502);
  return json({ reply });
}
