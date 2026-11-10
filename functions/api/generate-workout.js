
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

  if (origin && origin !== url.origin) {
    return json({ error: "invalid_origin" }, 403);
  }

  if (!env.GEMINI_API_KEY) {
    return json({ error: "gemini_not_configured" }, 500);
  }

  let body;
  try {
    const raw = await request.text();
    if (raw.length > 18000) {
      return json({ error: "request_too_large" }, 413);
    }
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_request" }, 400);
  }

  const r = body.recovery || {};
  const sleepTotalMinutes = Number(r.sleepTotalMinutes);
  const restingHR = Number(r.restingHR);
  const hrvMs = Number(r.hrvMs);
  const sleepStages = r.sleepStages && typeof r.sleepStages === "object" ? r.sleepStages : null;
  const sleepHeartRateAverage = Number(r.sleepHeartRateAverage);
  const fatigue = Number(r.fatigue);
  const feeling = r.wakingFeeling;

  if (
    !Number.isInteger(sleepTotalMinutes) || sleepTotalMinutes < 0 || sleepTotalMinutes > 1440 ||
    !Number.isFinite(restingHR) || restingHR < 25 || restingHR > 220 ||
    !Number.isFinite(hrvMs) || hrvMs < 0 || hrvMs > 300 ||
    !Number.isInteger(fatigue) || fatigue < 1 || fatigue > 10 ||
    !["muito_bem", "bem", "normal", "mal", "muito_mal"].includes(feeling)
  ) {
    return json({ error: "invalid_recovery_data" }, 400);
  }

  // Limite simples para reduzir gerações repetidas.
  // Como o site não exige login, isto não substitui autenticação.
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rateKey = new Request(
      `${url.origin}/__internal/generate-workout/${encodeURIComponent(ip)}`
    );
    const cache = caches.default;

    if (await cache.match(rateKey)) {
      return json({
        error: "rate_limited",
        message: "Aguarde um minuto antes de gerar outro treino."
      }, 429);
    }

    await cache.put(
      rateKey,
      new Response("limited", {
        headers: { "Cache-Control": "public, max-age=60" }
      })
    );
  } catch (error) {
    console.error("Não foi possível aplicar o limite temporário.");
  }

  const contexto = String(body.context || "").slice(0, 12000);
  const preferenciasTreino = String(body.availability || "").trim().slice(0, 150);
  const goal = String(body.goal || "general");
  const level = String(body.level || "intermediate");
  const goalNames = {
    endurance: "Resistência",
    strength: "Força",
    threshold: "Limiar",
    vo2max: "VO₂ máximo",
    recovery: "Recuperação / regenerativo",
    race: "Preparação para prova",
    general: "Condicionamento geral"
  };
  const levelNames = {
    beginner: "Iniciante",
    intermediate: "Intermediário",
    advanced: "Avançado"
  };
  const goalInstructions = {
    recovery: `OBJETIVO PRIORITÁRIO — REGENERATIVO / RECUPERAÇÃO:
- Este é um treino de recuperação, NÃO um treino de desenvolvimento físico.
- Prescreva somente pedal muito leve: priorize Z1. Em potência, mantenha os alvos na faixa de recuperação (preferencialmente até 55% do FTP). Em frequência cardíaca, use Z1/baixa intensidade e RPE 1–2/10; não transforme FC em alvo rígido durante esforços curtos.
- NÃO inclua Z3, Z4, Z5, Tempo, Sweet Spot, limiar, VO₂, tiros, sprints, subidas fortes ou blocos de intensidade.
- Evite blocos intervalados. O treino principal deve ser contínuo e leve; pequenas variações só se forem necessárias por segurança/terreno.
- A sessão deve ser curta e fácil. Respeite a disponibilidade informada; se não houver duração indicada, escolha uma sessão regenerativa breve, sem alongar para preencher tempo.
- Se fadiga percebida for muito alta (8–10/10), ou os dados/contexto apontarem recuperação claramente insuficiente, recomende descanso em vez de treino. Não invente diagnóstico nem interprete HRV isolada sem linha de base.
- O título, objetivo, explicação, etapas e treino estruturado do Intervals.icu devem todos refletir recuperação. Não basta chamar o treino de regenerativo se a intensidade não for regenerativa.`,
    endurance: `OBJETIVO PRIORITÁRIO — RESISTÊNCIA: priorize volume sustentável predominantemente em Z2, sem adicionar tiros fortes ou blocos de limiar/VO₂ se não forem necessários ao objetivo. Ajuste a duração à disponibilidade.`,
    strength: `OBJETIVO PRIORITÁRIO — FORÇA: selecione trabalho de força específica no ciclismo compatível com o nível e os dados disponíveis (por exemplo, torque/cadência baixa somente quando apropriado e seguro). Não confunda força com simplesmente aumentar toda a intensidade. Explique cadência e recuperação; não invente potência/zonas.`,
    threshold: `OBJETIVO PRIORITÁRIO — LIMIAR: se a recuperação permitir, inclua blocos controlados próximos ao limiar (Z4 ou equivalente do sensor selecionado), com aquecimento, recuperações e desaquecimento explícitos. Não substitua por VO₂ máximo.`,
    vo2max: `OBJETIVO PRIORITÁRIO — VO₂ MÁXIMO: se a recuperação permitir, use intervalos curtos/intensos apropriados ao nível, com recuperação suficiente e limites claros. Não transforme a sessão em endurance contínuo ou limiar longo.`,
    race: `OBJETIVO PRIORITÁRIO — PREPARAÇÃO PARA PROVA: construa uma sessão específica apenas com base nas informações reais de prova, modalidade, histórico e disponibilidade. Não invente percurso, duração da prova ou exigências que não foram informadas.`,
    general: `OBJETIVO PRIORITÁRIO — CONDICIONAMENTO GERAL: combine estímulos moderados e sustentáveis de acordo com nível, recuperação e disponibilidade. Evite intensidade alta sem justificativa.`
  }[goal] || `Siga o objetivo de condicionamento geral sem inventar dados.`;

  const tipoTreino = ({ indoor: "Indoor (rolo ou bicicleta ergométrica)", road: "Road (ciclismo de estrada)", mtb: "MTB (mountain bike)" })[body.location] || "Road (ciclismo de estrada)";
  const trainingMetric = body.trainingMetric === "power" ? "power" : "heart_rate";
  const fthr = Number(body.fthr);
  const ftp = Number(body.ftp) > 0 ? Number(body.ftp) : null;
  if (trainingMetric === "heart_rate" && (!Number.isFinite(fthr) || fthr < 80 || fthr > 220)) {
    return json({ error: "invalid_fthr", message: "Informe seu FTHR válido em bpm para gerar o treino por frequência cardíaca." }, 400);
  }
  if (trainingMetric === "power" && !ftp) {
    return json({ error: "invalid_ftp", message: "Informe seu FTP em watts para gerar o treino por potência." }, 400);
  }
  const hrZones = trainingMetric === "heart_rate" ? {
    z1: `${Math.round(fthr * 0.65)}–${Math.floor(fthr * 0.80)} bpm` ,
    z2: `${Math.ceil(fthr * 0.81)}–${Math.floor(fthr * 0.89)} bpm`,
    z3: `${Math.ceil(fthr * 0.90)}–${Math.floor(fthr * 0.93)} bpm`,
    z4: `${Math.ceil(fthr * 0.94)}–${Math.floor(fthr * 0.99)} bpm`,
    z5a: `${Math.ceil(fthr * 1.00)}–${Math.floor(fthr * 1.02)} bpm`,
    z5b: `${Math.ceil(fthr * 1.03)}–${Math.floor(fthr * 1.06)} bpm`,
    z5c: `acima de ${Math.floor(fthr * 1.06)} bpm`
  } : null;
  const metricInstructions = trainingMetric === "heart_rate"
    ? `MÉTODO DE PRESCRIÇÃO: FREQUÊNCIA CARDÍACA. O atleta NÃO possui medidor de potência. FTHR (limiar de FC): ${fthr} bpm.
Zonas de FC baseadas no FTHR: Z1 recuperação ${hrZones.z1}; Z2 resistência ${hrZones.z2}; Z3 tempo ${hrZones.z3}; Z4 limiar ${hrZones.z4}; Z5a ${hrZones.z5a}; Z5b ${hrZones.z5b}; Z5c ${hrZones.z5c}.
REGRA OBRIGATÓRIA: prescreva todos os blocos em bpm e zona de FC. NÃO informe watts, FTP, %FTP ou zonas de potência. Considere o atraso natural da FC em tiros curtos; use RPE/técnica como apoio e não force a FC a subir instantaneamente.`
    : `MÉTODO DE PRESCRIÇÃO: POTÊNCIA. FTP: ${ftp} W. Use watts, %FTP e zonas de potência. Não invente zonas de FC como alvo principal.`;
  const prompt = `
Você é treinador de ciclismo. Responda em português brasileiro, de forma objetiva, fácil de consultar durante o pedal e sem introdução longa.

TIPO DE TREINO: ${tipoTreino}
OBJETIVO ESCOLHIDO PELO ATLETA: ${goalNames[goal] || goal}
NÍVEL ESCOLHIDO PELO ATLETA: ${levelNames[level] || level}
${metricInstructions}

REGRAS DO OBJETIVO SELECIONADO:
${goalInstructions}
REGRA DE HIERARQUIA: respeite obrigatoriamente as seleções explícitas do atleta na caixa "Gerar meu treino". O objetivo escolhido define o tipo de estímulo; nível define a complexidade e a dose; tipo de treino define o contexto; sensor define a unidade/alvo; disponibilidade limita a duração; informações adicionais devem ser consideradas. A recuperação pode reduzir a carga ou recomendar descanso por segurança, mas nunca deve transformar silenciosamente o objetivo escolhido em outro tipo de sessão. Se houver conflito, explique brevemente no campo "Por que hoje".

RELATÓRIO / CONTEXTO:
${contexto || "Não há relatório de treino disponível."}

CHECK-IN DE HOJE:
- Tempo dormindo: ${Math.floor(sleepTotalMinutes / 60)}h ${sleepTotalMinutes % 60}min
- Estágios do sono (minutos): ${sleepStages ? `leve ${Number(sleepStages.core)||0}, profundo ${Number(sleepStages.deep)||0}, REM ${Number(sleepStages.rem)||0}, acordado ${Number(sleepStages.awake)||0}` : "não disponíveis"}
- FC média durante o sono: ${Number.isFinite(sleepHeartRateAverage) ? sleepHeartRateAverage + " bpm" : "não disponível"}
- FC em repouso: ${restingHR} bpm
- HRV: ${hrvMs} ms
- Sensação ao acordar: ${feeling.replaceAll("_", " ")}
- Fadiga: ${fatigue}/10
- Disponibilidade informada: ${preferenciasTreino || "Não informada"}. Não ultrapasse o tempo disponível.
- Informações adicionais do atleta: ${String(body.notes || "").trim().slice(0, 2000) || "Nenhuma"}. Considere-as explicitamente quando forem pertinentes.

Gere um treino adaptado ao objetivo selecionado, ao nível, ao tipo de treino, ao sensor, à disponibilidade, às informações adicionais, à recuperação e ao histórico disponível. Para Indoor, priorize blocos claros que possam ser seguidos no rolo; para Road, considere segurança e terreno; para MTB, considere terreno variável e controle técnico. Não invente histórico ausente, métricas, zonas, prova ou dados de desempenho. Não prescreva automaticamente alta intensidade se a recuperação não justificar. Nunca inclua um estímulo incompatível com o objetivo escolhido.

FORMATO OBRIGATÓRIO — mantenha conciso, sem saudação, sem repetir os dados do check-in e sem parágrafos longos:
## [Nome curto do treino]
**Objetivo:** uma frase.
**Duração:** total estimado.
**Por que hoje:** uma frase breve sobre recuperação/histórico.

## Treino
Use obrigatoriamente três subtítulos separados, nesta ordem, sem misturar as etapas:
### Aquecimento
Liste somente as etapas de aquecimento.
### Treino principal
Liste somente as etapas do objetivo selecionado. Coloque aqui as recuperações entre intervalos quando fizerem parte da série. Para regenerativo, mantenha o bloco principal contínuo, muito leve e sem intervalos.
### Desaquecimento
Liste somente as etapas de desaquecimento.
Em cada etapa, use o formato:
- **Nome da etapa — duração:** intensidade na unidade do sensor selecionado e instrução curta.
Não omita os subtítulos. Se recomendar descanso total por recuperação insuficiente, explique isso claramente e não invente etapas de pedal. A soma das durações das etapas deve corresponder à duração total estimada.

## Orientações rápidas
No máximo 3 itens curtos: RPE, FC como referência e hidratação/segurança. Inclua alerta para interromper em caso de dor, tontura ou sintomas incomuns.

Evite explicações fisiológicas extensas, avisos repetidos, títulos numerados em excesso e Markdown decorativo. Priorize leitura rápida em celular.
`;

  let resposta;
  try {
    resposta = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: 10000
          }
        })
      }
    );
  } catch {
    return json({ error: "gemini_unavailable" }, 502);
  }

  if (!resposta.ok) {
    console.error("Gemini retornou HTTP", resposta.status);
    return json({
      error: "gemini_http_" + resposta.status,
      message: "O serviço Gemini recusou a solicitação (HTTP " + resposta.status + "). Verifique a chave GEMINI_API_KEY, o acesso ao modelo e a cota da API no Google AI Studio."
    }, 502);
  }

  const resultado = await resposta.json();
  const treino = resultado?.candidates?.[0]?.content?.parts
    ?.map(parte => parte.text || "")
    .join("\n")
    .trim();

  if (!treino) {
    return json({ error: "empty_response" }, 502);
  }

  // CONFERÊNCIA INTELIGENTE: valida o treino contra as escolhas reais do atleta
  // antes de liberar o resultado ou enviar cópias ao Telegram/Intervals.icu.
  const reviewCriteria = {
    goal: goalNames[goal] || goal,
    level: levelNames[level] || level,
    activity: tipoTreino,
    metric: trainingMetric === "power" ? `Potência; FTP ${ftp} W` : `Frequência cardíaca; FTHR ${fthr} bpm`,
    availability: preferenciasTreino || "Não informada",
    plannedDate: String(body.plannedDate || "Não informada"),
    notes: String(body.notes || "").trim().slice(0, 2000) || "Nenhuma",
    recovery: {
      sleepMinutes: Number.isFinite(sleepTotalMinutes) ? sleepTotalMinutes : null,
      restingHR: Number.isFinite(restingHR) ? restingHR : null,
      hrvMs: Number.isFinite(hrvMs) ? hrvMs : null,
      fatigue: Number.isFinite(fatigue) ? fatigue : null,
      wakingFeeling: feeling || null
    }
  };

  const parseReview = raw => {
    const normalized = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try { return JSON.parse(normalized); } catch {
      const first = normalized.indexOf("{");
      const last = normalized.lastIndexOf("}");
      if (first >= 0 && last > first) return JSON.parse(normalized.slice(first, last + 1));
      throw new Error("A conferência retornou um formato inválido.");
    }
  };

  let reviewedWorkout = treino;
  let reviewApproved = false;
  let reviewIssues = [];
  let reviewAttempts = 0;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      reviewAttempts = attempt;
      const reviewPrompt = `
Você é o treinador-chefe e revisor técnico do Pedal Coach. Faça uma auditoria rigorosa do treino.
Compare o treino com as seleções e dados abaixo. Não presuma dados ausentes nem invente métricas.
CRITÉRIOS:
- O objetivo escolhido deve determinar o estímulo principal. Recuperação deve ser realmente regenerativa, preferencialmente Z1, sem intervalos intensos.
- Nível, modalidade e disponibilidade devem ser respeitados; a duração total não pode exceder o tempo informado.
- Use exclusivamente a unidade selecionada: potência (watts/%FTP) OU frequência cardíaca (bpm/zonas de FC). Não misture alvos incompatíveis.
- Só use valores de FTP/FTHR fornecidos. Não crie zonas ou números sem base.
- Sono, FC de repouso, HRV, fadiga e sensação só podem ser considerados quando disponíveis. Dados ausentes devem ser tratados como desconhecidos.
- Deve haver Aquecimento, Treino principal e Desaquecimento separados, nessa ordem, exceto quando recomendar descanso total de forma explícita.
- As durações das etapas devem ser coerentes com a duração total declarada.
- Rejeite contradições, carga claramente desproporcional ao nível/recuperação e conteúdo incompatível com objetivo.
DADOS SELECIONADOS:
${JSON.stringify(reviewCriteria)}
TREINO PARA AUDITAR:
${reviewedWorkout}
Responda SOMENTE JSON válido:
{"approved":true|false,"issues":["problema objetivo"],"correctedWorkout":"treino completo corrigido em português, mantendo as três seções obrigatórias"}
Se estiver correto, approved=true, issues=[] e correctedWorkout deve ser string vazia.
Se houver qualquer problema corrigível, approved=false e correctedWorkout deve conter o treino completo corrigido, sem acrescentar dados inventados.
Se não for possível corrigir sem inventar informação, approved=false e correctedWorkout vazio.
`;
      const reviewResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify({
            contents: [{ parts: [{ text: reviewPrompt }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 10000,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  approved: { type: "BOOLEAN" },
                  issues: { type: "ARRAY", items: { type: "STRING" } },
                  correctedWorkout: { type: "STRING" }
                },
                required: ["approved", "issues", "correctedWorkout"]
              }
            }
          })
        }
      );
      if (!reviewResponse.ok) {
        console.error("Falha na conferência inteligente. HTTP:", reviewResponse.status);
        return json({ error: "workout_review_unavailable", message: "Não foi possível concluir a conferência técnica do treino. Por segurança, ele não foi enviado nem publicado. Tente novamente." }, 502);
      }
      const reviewPayload = await reviewResponse.json();
      const reviewText = reviewPayload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
      let review;
      try { review = parseReview(reviewText); } catch {
        return json({ error: "workout_review_invalid", message: "A conferência técnica retornou uma resposta inválida. O treino não foi liberado nem enviado." }, 502);
      }
      if (review.approved === true) {
        reviewApproved = true;
        break;
      }
      reviewIssues = Array.isArray(review.issues) ? review.issues.map(x => String(x).slice(0, 240)) : [];
      const corrected = String(review.correctedWorkout || "").trim();
      if (!corrected) break;
      reviewedWorkout = corrected;
    }
  } catch (error) {
    console.error("Erro na conferência inteligente do treino.");
    return json({ error: "workout_review_unavailable", message: "A conferência técnica não pôde ser concluída. Por segurança, o treino não foi liberado nem enviado." }, 502);
  }

  if (!reviewApproved) {
    return json({
      error: "workout_review_rejected",
      message: "A conferência identificou incompatibilidades que não puderam ser resolvidas com segurança. Nenhum treino foi enviado ao Telegram ou ao Intervals.icu. Revise as escolhas e tente novamente.",
      reviewIssues,
      reviewAttempts
    }, 422);
  }

  const treinoValidado = reviewedWorkout;

  // Enviar o treinoValidado completo para o Telegram
  const tokenTelegram = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatIdTelegram = env.TELEGRAM_CHAT_ID?.trim();

  let telegramSent = false;
  let telegramErrorCode = null;
  let telegramMessagesSent = 0;
  let telegramMessagesTotal = 0;

  if (!tokenTelegram || !chatIdTelegram) {
    telegramErrorCode = "missing_config";
  } else {
    // Converter Markdown para texto mais legível no Telegram.
    const textoTelegram =
      "🚴 PEDAL COACH — TREINO GERADO\n\n" +
      treinoValidado
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*(.*?)\*\*/gs, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^\s*[-*]\s+/gm, "• ");

    // O Telegram aceita até 4096 caracteres por mensagem.
    // Dividimos em partes menores para enviar treinos longos.
    const caracteres = Array.from(textoTelegram);
    const partes = [];

    while (caracteres.length > 0) {
      if (caracteres.length <= 3900) {
        partes.push(caracteres.join("").trim());
        break;
      }

      let corte = -1;
      const minimo = Math.floor(3900 * 0.65);

      for (let i = 3899; i >= minimo; i--) {
        if (caracteres[i] === "\n") {
          corte = i;
          break;
        }
      }

      if (corte < 0) {
        for (let i = 3899; i >= minimo; i--) {
          if (caracteres[i] === " ") {
            corte = i;
            break;
          }
        }
      }

      if (corte < 0) corte = 3900;

      const parte = caracteres.splice(0, corte).join("").trim();
      if (parte) partes.push(parte);

      while (
        caracteres.length > 0 &&
        (caracteres[0] === "\n" || caracteres[0] === " ")
      ) {
        caracteres.shift();
      }
    }

    telegramMessagesTotal = partes.length;

    try {
      for (const parte of partes) {
        const respostaTelegram = await fetch(
          `https://api.telegram.org/bot${tokenTelegram}/sendMessage`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              chat_id: chatIdTelegram,
              text: parte,
              disable_web_page_preview: true
            })
          }
        );

        const resultadoTelegram = await respostaTelegram
          .json()
          .catch(() => ({}));

        if (!respostaTelegram.ok || !resultadoTelegram.ok) {
          telegramErrorCode = `telegram_http_${respostaTelegram.status}`;
          console.error(
            "Falha no envio ao Telegram. HTTP:",
            respostaTelegram.status
          );
          break;
        }

        telegramMessagesSent++;
      }

      telegramSent =
        telegramMessagesSent === telegramMessagesTotal &&
        telegramMessagesTotal > 0;

      if (!telegramSent && !telegramErrorCode) {
        telegramErrorCode = "telegram_partial_send";
      }
    } catch {
      telegramErrorCode = "telegram_network_error";
    }
  }

  // Publica o treinoValidado estruturado no Intervals.icu quando a chave pessoal estiver configurada.
  // O texto é convertido para a sintaxe nativa do Workout Builder; nenhum alvo ou duração
  // pode ser inventado durante a conversão.
  let intervalsSent = false;
  let intervalsErrorCode = null;
  let intervalsEventId = null;
  let intervalsMessage = null;
  const intervalsApiKey = String(env.INTERVALS_API_KEY || "").trim();
  const plannedDate = String(body.plannedDate || "").trim();
  if (!intervalsApiKey) {
    intervalsErrorCode = "missing_config";
    intervalsMessage = "Integração Intervals.icu ainda não configurada no Cloudflare.";
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate) ||
      Number.isNaN(Date.parse(plannedDate + "T12:00:00Z")) ||
      new Date(plannedDate + "T12:00:00Z").toISOString().slice(0, 10) !== plannedDate) {
    intervalsErrorCode = "invalid_date";
    intervalsMessage = "Informe uma data válida para o treinoValidado.";
  } else {
    try {
      const conversionResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY
          },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `Converta o treinoValidado abaixo para a sintaxe nativa do Workout Builder do Intervals.icu.
Responda SOMENTE com JSON válido, sem markdown, neste formato:
{"name":"nome curto","description":"texto de etapas"}

REGRAS OBRIGATÓRIAS:
- Preserve exatamente todas as etapas, durações, repetições, faixas e instruções de intensidade do treinoValidado original.
- Não invente, estime, arredonde nem altere watts, bpm, percentuais, zonas, cadência ou duração.
- A descrição deve ter SEÇÕES SEPARADAS, nesta ordem e com linhas em branco entre elas: "Warmup", "Main Set" e "Cooldown".
- Coloque cada etapa de aquecimento somente sob o cabeçalho "Warmup"; cada bloco de esforço/recuperação do treinoValidado principal sob "Main Set"; e cada etapa de desaquecimento somente sob "Cooldown".
- Não junte aquecimento, treinoValidado principal e desaquecimento em uma única seção. Não omita cabeçalhos das seções que existirem no treinoValidado original.
- Dentro de cada seção, cada etapa executável deve ser uma linha iniciada por "- ". A sintaxe nativa é duração, alvo, texto/cue opcional. Exemplo: "- 15m 55% Warmup".
- Exemplos de etapas: "- 18m 215-230w Tempo 85-95rpm", "- 5m 140-180w Recovery", "- 10m Z2 HR Endurance".
- Use cabeçalhos de seção sem hífen (por exemplo, "Warmup", "Main Set", "Cooldown"). Esses cabeçalhos identificam as divisões e não são etapas executáveis.
- Durações válidas: 20m, 1h, 1h30m, 30s.
- Potência: 215-230w, 180w, 75-85% ou Z2. Frequência cardíaca: Z2 HR ou percentuais de LTHR.
- Se o controle for frequência cardíaca e o original trouxer alvos em bpm, use o FTHR informado (${fthr} bpm) para converter cada limite para percentual de LTHR (bpm ÷ FTHR × 100), com uma casa decimal. Não use faixas absolutas em bpm na sintaxe final.
- Para aquecimento/desaquecimento com progressão, use "ramp" somente quando houver alvo inicial e final explícitos no treinoValidado original. Exemplo: "- Warmup 10m ramp 100-150w".
- Para blocos repetidos, use cabeçalho "3x" sozinho em uma linha e depois as linhas das etapas repetidas, dentro da seção "Main Set", conforme a sintaxe Intervals.icu. Deixe uma linha em branco ao redor do bloco de repetição.
- Preserve notas como cadência na etapa, quando fornecidas.
- Não inclua aquecimento, recuperação ou desaquecimento que não existam no original. A recuperação entre tiros que faz parte do treinoValidado principal permanece em "Main Set".
- Se o treinoValidado não tiver etapas estruturadas suficientes para converter fielmente, retorne {"name":"...","description":""}.
- Não inclua TSS, carga, FTP ou métricas calculadas.

TREINO ORIGINAL:
${treinoValidado}`
              }]
            }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 4000,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  description: { type: "STRING" }
                },
                required: ["name", "description"]
              }
            }
          })
        }
      );

      if (!conversionResponse.ok) {
        throw Object.assign(new Error("Não foi possível converter o treinoValidado para o formato Intervals.icu."), { code: "conversion_failed" });
      }

      const conversionPayload = await conversionResponse.json();
      const conversionText = conversionPayload?.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "").join("").trim();
      if (!conversionText) throw Object.assign(new Error("A conversão não retornou etapas."), { code: "invalid_conversion" });

      // Aceita JSON puro e também uma resposta que venha cercada por bloco Markdown
      // ou texto adicional, sem alterar os dados prescritos pelo treinador.
      const normalizedConversionText = conversionText
        .replace(/^\`\`\`(?:json)?\s*/i, "")
        .replace(/\s*\`\`\`$/i, "")
        .trim();
      let converted;
      try {
        converted = JSON.parse(normalizedConversionText);
      } catch {
        const firstBrace = normalizedConversionText.indexOf("{");
        const lastBrace = normalizedConversionText.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
          try {
            converted = JSON.parse(normalizedConversionText.slice(firstBrace, lastBrace + 1));
          } catch {
            throw Object.assign(new Error("A conversão do treinoValidado retornou um formato inválido. Tente gerar novamente; o treinoValidado original continua salvo no site e no Telegram."), { code: "invalid_conversion" });
          }
        } else {
          throw Object.assign(new Error("A conversão do treinoValidado retornou um formato inválido. Tente gerar novamente; o treinoValidado original continua salvo no site e no Telegram."), { code: "invalid_conversion" });
        }
      }
      if (!converted || typeof converted !== "object" || Array.isArray(converted)) {
        throw Object.assign(new Error("A conversão não retornou os campos esperados. Tente gerar novamente; o treinoValidado original continua salvo no site e no Telegram."), { code: "invalid_conversion" });
      }

      const intervalsName = String(converted.name || "Treino Pedal Coach").trim().slice(0, 100);
      const intervalsDescription = String(converted.description || "").trim();
      const executableLines = intervalsDescription.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.startsWith("- "));
      const hasDurationAndTarget = executableLines.length > 0 &&
        executableLines.every(line =>
          /(?:\b\d+h(?:\d+m)?(?:\d+s)?\b|\b\d+m(?:\d+s)?\b|\b\d+s\b)/i.test(line) &&
          /(\d+(?:-\d+)?\s*w\b|\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?%|\bZ[1-7](?:-Z[1-7])?\s*HR?\b|\bZ[1-7](?:-Z[1-7])?\b)/i.test(line)
        );

      if (!intervalsDescription || !hasDurationAndTarget) {
        throw Object.assign(new Error("Não foi possível identificar etapas estruturadas válidas sem presumir dados. O treinoValidado foi mantido no site e no Telegram."), { code: "invalid_conversion" });
      }

      const auth = btoa("API_KEY:" + intervalsApiKey);
      const eventPayload = [{
        category: "WORKOUT",
        start_date_local: plannedDate + "T00:00:00",
        type: "Ride",
        name: intervalsName,
        description: intervalsDescription,
        target: body.trainingMetric === "power" ? "POWER" : "HR",
        indoor: body.location === "indoor",
        external_id: "pedal-coach-" + plannedDate
      }];

      const intervalsResponse = await fetch(
        "https://intervals.icu/api/v1/athlete/0/events/bulk?upsert=true",
        {
          method: "POST",
          headers: {
            "Authorization": "Basic " + auth,
            "Content-Type": "application/json",
            "Accept": "application/json"
          },
          body: JSON.stringify(eventPayload)
        }
      );

      const intervalsResult = await intervalsResponse.json().catch(() => null);
      if (!intervalsResponse.ok || !Array.isArray(intervalsResult) || !intervalsResult[0]?.id) {
        const status = intervalsResponse.status;
        intervalsErrorCode = status === 401 || status === 403
          ? "intervals_auth_failed"
          : "intervals_publish_failed";
        intervalsMessage = status === 401 || status === 403
          ? "O Intervals.icu recusou a chave. Confira a chave pessoal configurada no Cloudflare."
          : "O Intervals.icu não confirmou a criação do treinoValidado (HTTP " + status + ").";
      } else {
        intervalsSent = true;
        intervalsEventId = intervalsResult[0].id;
        intervalsMessage = "Treino estruturado criado no calendário do Intervals.icu.";
      }
    } catch (error) {
      intervalsErrorCode = error?.code || "intervals_unavailable";
      intervalsMessage = error?.message || "Não foi possível enviar o treinoValidado ao Intervals.icu.";
      console.error("Falha ao publicar treinoValidado no Intervals.icu:", intervalsErrorCode);
    }
  }

  return json({
    workout: treinoValidado,
    telegramSent,
    telegramErrorCode,
    telegramMessagesSent,
    telegramMessagesTotal,
    intervalsSent,
    intervalsErrorCode,
    intervalsEventId,
    intervalsMessage
  });
}
