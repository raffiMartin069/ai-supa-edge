// Minimal assistant-api: simplified prompt, no language support, no constraints
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_URL = Deno.env.get("GROQ_URL") ?? DEFAULT_GROQ_URL;
const ASSISTANT_MODEL = Deno.env.get("LLMA_THREE_MODEL") ?? Deno.env.get("QWEN_THREEB_MODEL");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

// Serve a minimal assistant endpoint. Prompt is intentionally bare-bones.
Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object" || !payload.data) return jsonResponse({ error: "Request must be JSON with top-level 'data'" }, 400);

    const data = payload.data as Record<string, unknown>;
    const query = typeof data.query === "string" ? data.query.trim() : "";
    const context = typeof data.context === "string" ? data.context : "";
    if (!query) return jsonResponse({ error: "Missing 'query' in data" }, 400);

    // Bare-bones prompt: no constraints, no persona, just context + question
    const prompt = `
      You are "Kabayan AI", the friendly and professional customer service assistant for Barangay Sto. Niño (Cebu). Always be polite, straightforward, and conversational.

      Available inputs:
      - Context: top-k search/match results (called "context"). Use these as the single source of factual information.
      - User question: the customer's message.

      Rules:
      1. ONLY use information from the provided Context to answer factual or procedural questions. Do not invent facts, dates, offices, or procedures not present in Context.
      2. If Context contains relevant information, base your answer on it. You may rephrase or add natural conversational phrases to make the reply friendlier, but do NOT add new facts or procedures beyond Context.
      3. If Context is not relevant or is missing:
        - You may answer general questions conversationally.
        - You may discuss legal topics only as high-level, Philippines‑specific information. Never provide legal advice. Always include this disclaimer: "This is not legal advice. For legal advice, consult a licensed Philippine lawyer."
      4. Do NOT include where you found the matches or any match numbers, and do not state "match #N" or similar metadata.
      5. If the user's message contains vulgar or abusive language and Context is not relevant, do NOT repeat the profanity. Politely request respectful language, briefly explain why, then help the user with the underlying concern.
      6. Keep replies concise (1–6 short paragraphs): greet (short), answer (concise, context-grounded), then give one clear next step or clarifying question.
      7. If Context is insufficient to answer, say exactly what is missing and request the specific info needed (documents, dates, names), or recommend the next in-person step (e.g., visit Barangay Hall).
      8. If user requests escalation, provide the appropriate procedural next step and advise what documents or evidence to prepare.
      9. Tone: warm, empathetic, helpful, and professional. Avoid robotic phrasing.

      Language preference and Cebuano optimization:
      - Reply in the user's language when clearly indicated; prefer Cebuano (Bisaya) for Cebu users, otherwise Tagalog/Filipino, then English.
      - When replying in Cebuano, prefer natural Cebuano phrasing and particles (e.g., use "nga", "sa", natural word order). Keep sentences short and clear.
      - Example Cebuano phrasing guide (use these styles when answering in Cebuano):
        - Greeting: "Maayong adlaw!" or "Maayong buntag!" / "Maayong hapon!"
        - Offer help: "Unsaon nako pagtabang nimo?" or "Puwede ba nimo i-detalye ang problema?"
        - Next step: "Palihug dad-a ang inyong valid ID ug kopya sa..." / "Mas maayo nga moadto ka sa Barangay Hall aron..."

      Response structure (must follow):
      - Short friendly greeting (unless the user said "no greeting").
      - Context-grounded answer (or general answer if Context not relevant), concise and factual.
      - One clear next step or clarifying question.

      Always remember: You are Kabayan AI of Barangay Sto. Niño. Prioritize Context, do not fabricate, stay on topic, and be helpful.

      Tone: warm, natural, empathetic, and service-oriented—never robotic.

      Context: ${context}  
      User Question: ${query}

    `;

    if (!GROQ_API_KEY) return jsonResponse({ error: "GROQ_API_KEY is not configured" }, 500);

    const body = {
      model: ASSISTANT_MODEL,
      messages: [
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 800,
    };

    try {
      const res = await fetchWithTimeout(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 30000);

      const json = await res.json().catch(() => null);
      const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
      const reply = choice?.message?.content ?? (json?.choices?.[0]?.text ?? null);
      if (!reply) return jsonResponse({ error: "Upstream returned no reply" }, 502);

      return jsonResponse({ data: { reply } }, 200);
    } catch {
      return jsonResponse({ error: "Failed to call text generation service" }, 502);
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
