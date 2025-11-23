// Minimal assistant-api: simplified prompt, no language support, no constraints
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_URL = Deno.env.get("GROQ_URL") ?? DEFAULT_GROQ_URL;
const ASSISTANT_MODEL = Deno.env.get("LLMA_THREE_MODEL") ?? Deno.env.get("QWEN_THREEB_MODEL");
const _GEMINI_MODEL = Deno.env.get("GEMINI_MODEL");
const _GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// (no local normalization here; assistant-api returns GROQ responses as-is but forces English)

// Simple relevance heuristic: check overlap of words between query and context.
function isContextRelevant(query: string, context: string): boolean {
  try {
    if (!context || context.trim().length < 20) return false;
    const q = query.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const c = context.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const setC = new Set(c);
    let matches = 0;
    for (const w of q) {
      if (setC.has(w)) matches++;
    }
    return matches >= Math.min(3, Math.max(1, Math.floor(q.length / 4)));
  } catch {
    return false;
  }
}

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(extraHeaders ?? {}) };
  return new Response(JSON.stringify(body), { status, headers });
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
    console.log(`[Incoming Payload] query length: ${query.length}, context: ${context}`);
    // Determine context relevance and build prompt.
    const relevant = isContextRelevant(query, context);
    const relevantStr = relevant ? "YES" : "NO";

    // Bare-bones prompt: no constraints, no persona, just context + question
    // Note: assistant-api responds ONLY in English.
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

      NOTE: Respond ONLY in English regardless of user's language.

      Response structure (must follow):
      - Short friendly greeting (unless the user said "no greeting").
      - Context-grounded answer (or general answer if Context not relevant), concise and factual.
      - One clear next step or clarifying question.

      Always remember: You are Kabayan AI of Barangay Sto. Niño. Prioritize Context, do not fabricate, stay on topic, and be helpful.

      Tone: warm, natural, empathetic, and service-oriented—never robotic.

      Context relevance: ${relevantStr}
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

    // If Gemini configured, try it first (dynamic npm import). If it fails,
    // fall back to GROQ-compatible endpoint.
    // This endpoint is GROQ-only. We'll still record geminiDebug as null for meta.
    const geminiDebug: string | null = null;

    try {
      console.log(`Using GROQ endpoint: ${GROQ_URL} with model ${ASSISTANT_MODEL}`);
      const groqReqPreview = JSON.stringify(body).slice(0, 2000);
      console.log("GROQ request body (truncated):", groqReqPreview.length ? groqReqPreview : "<empty>");
      const res = await fetchWithTimeout(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 30000);

      // log groq response headers
      try {
        const hdrs: Record<string, string> = {};
        for (const [k, v] of (res.headers as Headers).entries()) hdrs[k] = v;
        console.log("GROQ response headers:", JSON.stringify(hdrs).slice(0, 1000));
      } catch { /* ignore */ }

      const json = await res.json().catch(() => null);
      const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
      const reply = choice?.message?.content ?? (json?.choices?.[0]?.text ?? null);
      if (!reply) return jsonResponse({ error: "Upstream returned no reply", meta: { modelUsed: "groq", modelId: ASSISTANT_MODEL ?? "unknown", geminiDebug } }, 502, { "X-Model-Used": "groq", "X-Model-Id": ASSISTANT_MODEL ?? "unknown" });

      return jsonResponse({ data: { reply }, meta: { modelUsed: "groq", modelId: ASSISTANT_MODEL ?? "unknown", geminiDebug } }, 200, { "X-Model-Used": "groq", "X-Model-Id": ASSISTANT_MODEL ?? "unknown" });
    } catch (err) {
      console.error("GROQ call failed:", err);
      return jsonResponse({ error: "Failed to call text generation service", meta: { modelUsed: "groq", modelId: ASSISTANT_MODEL ?? "unknown", geminiDebug } }, 502);
    }
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
