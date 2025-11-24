// Minimal assistant-api: simplified prompt, no language support, no constraints
/*
  Detailed internal documentation (surgical explanation of operations)

  This file implements a simple assistant endpoint designed to use a GROQ/OpenAI-compatible
  endpoint as the text generation backend. The function is intentionally minimal and forces
  English-only responses. The following comments document every step and the purpose of
  the surrounding code to make it easy to audit and reason about runtime behavior.

  High-level flow:
   1. Validate incoming HTTP request (JSON body with top-level `data`).
   2. Extract `query` and optional `context` from `data`.
   3. Compute a simple context-relevance heuristic to decide whether `context` should
      be treated as relevant when building the prompt.
   4. Construct a compact prompt instructing the model (Kabayan AI persona, rules).
   5. Call a GROQ/OpenAI-compatible API with a chat-completions like payload.
   6. Parse the provider response and return a JSON payload with `data.reply` and `meta`.

  Notes:
   - This module intentionally does NOT perform language detection; it forces English.
   - The function does not call Gemini or other direct providers here; that logic
     was moved to `gemini-assistant`. This file serves as the GROQ fallback.
*/
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_URL = Deno.env.get("GROQ_URL") ?? DEFAULT_GROQ_URL;
const ASSISTANT_MODEL = Deno.env.get("LLMA_THREE_MODEL") ?? Deno.env.get("QWEN_THREEB_MODEL");
const _GEMINI_MODEL = Deno.env.get("GEMINI_MODEL");
const _GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// (no local normalization here; assistant-api returns GROQ responses as-is but forces English)

// Simple relevance heuristic: check overlap of words between query and context.
/*
  isContextRelevant(query, context)
  ---------------------------------
  Purpose:
    A lightweight, deterministic heuristic used to decide whether the provided
    `context` (typically concatenated FAQ matches) contains enough overlapping
    vocabulary with the `query` to be considered relevant.

  Behavior (step-by-step):
    1. Guard: If `context` is missing or very short (< 20 chars) -> return false.
    2. Normalize both `query` and `context` to lower-case and remove non-alphanum
       characters so punctuation doesn't create false misses.
    3. Tokenize on whitespace and drop empty tokens.
    4. Build a Set from the context tokens for O(1) membership checks.
    5. Count how many query tokens are present in the context set.
    6. Compare `matches` to a threshold computed as min(3, max(1, floor(q.length/4))).
       This scales the required overlap with query length but caps it at 3 tokens.
    7. Return true when matches >= threshold.

  Rationale:
    This heuristic is intentionally simple and fast (no external calls). It avoids
    costly model-based relevance checks while providing a reasonable indicator
    for whether to expose context to the model prompt as factual source material.
*/
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

/*
  jsonResponse
  ------------
  Small helper that centralizes JSON responses and header handling.

  Why it exists:
    - Ensures every response from this function uses `application/json`.
    - Allows callers to attach additional headers (such as X-Model-Used) in one place.
*/

async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

/*
  fetchWithTimeout
  ----------------
  Purpose: Wrap `fetch` with a simple AbortController-based timeout so upstream
  provider requests do not hang forever. The function returns the fetch Response
  or throws when the operation times out (caller should handle thrown errors).

  Notes:
    - The default timeout is 20 seconds; longer timeouts may be required for
      some providers — adjust when needed via the `timeoutMs` parameter.
*/

// Serve a minimal assistant endpoint. Prompt is intentionally bare-bones.
Deno.serve(async (req: Request) => {
  /*
    Top-level request handler (Deno.serve)

    Step-by-step behavior documented inline below:
      - Validate method and payload shape
      - Extract `query` and `context`
      - Build persona prompt with rules and the context relevance flag
      - Call the GROQ/OpenAI-compatible endpoint
      - Parse response and return JSON with `data.reply` and `meta`
  */
  try {
    // NOTE: CORS preflight handling may be done by a wrapper -- we only respond
    // to OPTIONS here with a minimal 204 so client preflights succeed.
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    // 1) Parse and validate incoming JSON payload
    //    Expected shape: { data: { query: string, context?: string } }
    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object" || !payload.data) {
      // Return 400 for malformed input. Keep response shape consistent via helper.
      return jsonResponse({ error: "Request must be JSON with top-level 'data'" }, 400);
    }

    // 2) Extract typed fields from the payload and perform minimal validation
    const data = payload.data as Record<string, unknown>;
    const query = typeof data.query === "string" ? data.query.trim() : "";
    const context = typeof data.context === "string" ? data.context : "";
    if (!query) return jsonResponse({ error: "Missing 'query' in data" }, 400);

    // Lightweight logging to help debugging in the function logs
    console.log(`[assistant-api] incoming query length=${query.length}`);

    // 3) Determine whether provided context is relevant. This influences the
    //    prompt text where we include a `Context relevance: YES/NO` marker.
    const relevant = isContextRelevant(query, context);
    const relevantStr = relevant ? "YES" : "NO";

    // 4) Build the prompt. This string bundles persona, explicit rules, and
    //    the user's question plus the provided context. The model is instructed
    //    to respond ONLY in English.
    //    The prompt is intentionally compact and explicit to improve deterministic
    //    behavior from the downstream completion service.
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

    // 5) Validate configuration: ensure the GROQ API key is present before
    //    making network calls. Returning an explicit 500 here surfaces a
    //    misconfiguration quickly to deploy-time checks.
    if (!GROQ_API_KEY) return jsonResponse({ error: "GROQ_API_KEY is not configured" }, 500);

    // 6) Build the request payload expected by GROQ/OpenAI-like chat completion endpoints.
    //    We use `messages` with a single `user` message carrying the prompt for simplicity.
    const body = {
      model: ASSISTANT_MODEL,
      messages: [
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 800,
    };

    // `geminiDebug` kept as null here to maintain consistent `meta` shape with other endpoints.
    const geminiDebug: string | null = null;

    // 7) Perform the network call to GROQ/OpenAI-compatible endpoint inside try/catch
    //    to convert network or provider errors into 502 responses.
    try {
      console.log(`assistant-api -> calling GROQ endpoint ${GROQ_URL} model=${ASSISTANT_MODEL}`);
      const groqReqPreview = JSON.stringify(body).slice(0, 2000);
      // Log a truncated preview of the request body for observability (avoids huge logs)
      console.log("GROQ request body (truncated):", groqReqPreview.length ? groqReqPreview : "<empty>");

      // Actual HTTP call with timeout wrapper
      const res = await fetchWithTimeout(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, 30000);

      // 8) Optionally log response headers for debugging (truncated)
      try {
        const hdrs: Record<string, string> = {};
        for (const [k, v] of (res.headers as Headers).entries()) hdrs[k] = v;
        console.log("GROQ response headers:", JSON.stringify(hdrs).slice(0, 1000));
      } catch { /* ignore header logging errors */ }

      // 9) Parse the provider response body. Different providers may return
      //    slightly different shapes; we defensively attempt to locate the
      //    textual reply in `choices[0].message.content` or `choices[0].text`.
      const json = await res.json().catch(() => null);
      const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
      const reply = choice?.message?.content ?? (json?.choices?.[0]?.text ?? null);

      // 10) If no text reply found, return 502 with meta so calling services can
      //     see which model was used and whether geminiDebug exists.
      if (!reply) return jsonResponse({ error: "Upstream returned no reply", meta: { modelUsed: "groq", modelId: ASSISTANT_MODEL ?? "unknown", geminiDebug } }, 502, { "X-Model-Used": "groq", "X-Model-Id": ASSISTANT_MODEL ?? "unknown" });

      // 11) Successful path: return the reply inside `data.reply` and attach `meta`.
      //     We also set response headers with model metadata to assist downstream tracing.
      return jsonResponse({ data: { reply }, meta: { modelUsed: "groq", modelId: ASSISTANT_MODEL ?? "unknown", geminiDebug } }, 200, { "X-Model-Used": "groq", "X-Model-Id": ASSISTANT_MODEL ?? "unknown" });
    } catch (err) {
      // 12) Network or provider error handling: log and return a 502 error.
      console.error("GROQ call failed:", err);
      return jsonResponse({ error: "Failed to call text generation service", meta: { modelUsed: "groq", modelId: ASSISTANT_MODEL ?? "unknown", geminiDebug } }, 502);
    }
  } catch (err) {
    // 13) Catch-all error handling for unexpected runtime issues inside the function.
    //     Return a 500 with the error message for debugging; production systems
    //     may want to hide details from end users.
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
