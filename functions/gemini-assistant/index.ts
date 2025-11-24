// Gemini-backed assistant for Barangay Sto. Niño (Cebu)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

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

// Extract text from various Gemini response shapes.
function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return null;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const v of value) {
      const t = extractText(v);
      if (t) parts.push(t);
    }
    return parts.length ? parts.join("\n") : null;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.parts)) {
      const parts: string[] = [];
      for (const p of obj.parts) {
        if (p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string") {
          parts.push(((p as Record<string, unknown>).text as string));
        }
      }
      if (parts.length) return parts.join("\n");
    }
    if (Array.isArray(obj.content)) {
      const t = extractText(obj.content);
      if (t) return t;
    }
    if (obj.content && typeof obj.content === "object" && !Array.isArray(obj.content)) {
      const t = extractText(obj.content as Record<string, unknown>);
      if (t) return t;
    }
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.outputs)) return extractText(obj.outputs);
    if (Array.isArray(obj.candidates)) return extractText(obj.candidates);
    if (Array.isArray(obj.output)) return extractText(obj.output);
    if (obj.candidates && typeof obj.candidates === "object" && !Array.isArray(obj.candidates)) {
      const t = extractText(obj.candidates as Record<string, unknown>);
      if (t) return t;
    }
    if (obj.output && typeof obj.output === "object" && !Array.isArray(obj.output)) {
      const t = extractText(obj.output as Record<string, unknown>);
      if (t) return t;
    }
  }
  return null;
}

function normalizeReply(s: string): string {
  let out = s.replace(/\r\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  return out.trim();
}

// Relevance heuristic (same as assistant-api)
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

// Call Gemini generateContent and return cleaned reply + debug
async function generateWithGemini(prompt: string): Promise<{ reply: string | null; debug?: string | null }> {
  if (!GEMINI_MODEL || !GEMINI_API_KEY) return { reply: null, debug: "missing_config" };
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
    const body = { contents: [{ parts: [{ text: prompt }] }] } as Record<string, unknown>;
    console.log(`Gemini call -> ${endpoint}`);
    const res = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body),
    }, 30000);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(txt) as Record<string, unknown>; } catch { /* ignore */ }
      const errorObj = parsed && typeof parsed === "object" && "error" in parsed ? (parsed["error"] as Record<string, unknown>) : null;
      const msg = errorObj && typeof errorObj["message"] === "string" ? errorObj["message"] as string : txt;
      console.warn("Gemini non-ok:", res.status, msg);
      return { reply: null, debug: typeof msg === "string" ? msg.slice(0, 2000) : String(msg) };
    }
    const json = await res.json().catch(() => null);
    const candidates = [json?.outputs ?? null, json?.output ?? null, json?.candidates ?? null, json?.content ?? null, json?.text ?? null, json ?? null];
    for (const c of candidates) {
      const extracted = extractText(c);
      if (extracted && extracted.trim().length > 0) return { reply: normalizeReply(extracted) };
    }
    try { return { reply: null, debug: JSON.stringify(json).slice(0, 2000) }; } catch { return { reply: null, debug: "unstringifiable_response" }; }
  } catch (e) {
    console.error("Gemini call error:", e);
    return { reply: null, debug: e instanceof Error ? e.message : String(e) };
  }
}

// Handler: uses top-k context in `data.context`, detects language, builds a prompt tailored to detected language,
// asks Gemini to generate, cleans result and returns it with meta.
Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object" || !payload.data) return jsonResponse({ error: "Request must be JSON with top-level 'data'" }, 400);

    const data = payload.data as Record<string, unknown>;
    const query = typeof data.query === "string" ? data.query.trim() : "";
    const context = typeof data.context === "string" ? data.context : "";
    if (!query) return jsonResponse({ error: "Missing 'query' in data" }, 400);

    // const lang = detectLanguage(query);
    const relevant = isContextRelevant(query, context);
    const relevantStr = relevant ? "YES" : "NO";

    if (!GEMINI_MODEL || !GEMINI_API_KEY) return jsonResponse({ error: "GEMINI_MODEL or GEMINI_API_KEY not configured" }, 500);

    const prompt = `You are Kabayan AI, a warm, professional multilingual customer service assistant. 

      Available inputs:
      - Context: top-k search/match results (called 'context') — use these as the single source of facts.
      - User question: the customer's message.

      Rules:
      1. ONLY use information from the provided Context for factual/procedural answers. Do not invent facts beyond Context.
      2. If Context is missing or not relevant, answer conversationally but do NOT provide legal advice — only high-level Philippines-specific information and include: "This is not legal advice. For legal advice, consult a licensed Philippine lawyer."
      3. Keep replies concise: short greeting (unless user asked for none), context-grounded answer, then one clear next step or clarifying question.
      4. If user is abusive and Context not relevant, do not repeat profanity; request respectful language then help.
      5. Reply in the language of the user's question (Cebuano, Tagalog, or English). Use polite/formal tone (e.g., "po", "opo" in Tagalog).

      Context relevance: ${relevantStr}
      Context: ${context}
      User Question: ${query}
      `;

    const g = await generateWithGemini(prompt);
    const geminiDebug = g.debug ?? null;
    if (!g.reply) {
      console.warn("Gemini produced no reply; debug:", geminiDebug);
      return jsonResponse({ error: "Gemini returned no reply", meta: { modelUsed: "gemini", modelId: GEMINI_MODEL, geminiDebug } }, 502, { "X-Model-Used": "gemini", "X-Model-Id": GEMINI_MODEL ?? "unknown" });
    }

    return jsonResponse({ data: { reply: g.reply }, meta: { modelUsed: "gemini", modelId: GEMINI_MODEL, geminiDebug } }, 200, { "X-Model-Used": "gemini", "X-Model-Id": GEMINI_MODEL ?? "unknown" });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
