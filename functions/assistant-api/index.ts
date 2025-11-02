// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Assistant API
 * - Receives { data: { query, context, matches } }
 * - Builds the assistant prompt (Barangay Hall persona + guidelines)
 * - Calls the configured third-party text generation endpoint (default: GROQ)
 * - Returns { data: { reply } } on success
 *
 * Environment variables:
 * - GROQ_API_KEY (required if using GROQ)
 * - GROQ_URL (optional, defaults to https://api.groq.com/openai/v1/chat/completions)
 * - ASSISTANT_MODEL (optional, provider/model to request)
 */

const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_URL = Deno.env.get("GROQ_URL") ?? DEFAULT_GROQ_URL;
const ASSISTANT_MODEL = Deno.env.get("ASSISTANT_MODEL") ?? "llama-3.3-70b-versatile";

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

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object" || !payload.data) {
      return jsonResponse({ error: "Request must be JSON with top-level 'data'" }, 400);
    }
    const data = payload.data as Record<string, unknown>;
    const query = typeof data.query === "string" ? data.query.trim() : "";
    const context = typeof data.context === "string" ? data.context : "";

    if (!query) return jsonResponse({ error: "Missing 'query' in data" }, 400);

    // Build prompt (same persona/guidelines as before)
    const prompt = `You are Kabayan, a reliable and professional customer service representative for a Barangay Hall. Your job is to provide clear, helpful, and complete answers to customer questions using both the provided context and updated, reliable external information when necessary.

Guidelines:

Before answering, work through this step-by-step:

1. UNDERSTAND: What is the core question being asked?
2. ANALYZE: What are the key factors/components involved?
3. REASON: What logical connections can I make?
4. SYNTHESIZE: How do these elements combine?
5. CONCLUDE: What is the most accurate/helpful response?

Now answer:

1. You must act like a smart and helpful AI assistant, always aiming to give the best and most accurate response possible.
2. Base your answer primarily on the given context (top results). Assess if the information is relevant and complete.
3. If the information from the context is unrelated or incomplete but the question is within Barangay Hall services, you may consult reliable external sources. Do not fabricate information.
4. Provide step-by-step instructions when appropriate.
5. Match the customer's language (Tagalog/Bisaya/English) when possible.
6. For legal questions, do NOT provide legal advice — recommend consulting a lawyer or local legal office.

Context:
${context}

Customer's Question:
${query}

Your Response:
`;

    // Build request body for Groq-compatible endpoint (OpenAI-compatible shape)
    const body = {
      model: ASSISTANT_MODEL,
      messages: [
        { role: "system", content: "You are a helpful assistant for Barangay Hall services." },
        { role: "user", content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 800
    };

    if (!GROQ_API_KEY) {
      return jsonResponse({ error: "GROQ_API_KEY is not configured in the function environment" }, 500);
    }

    // simple single-retry logic for transient failures
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetchWithTimeout(GROQ_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, 30000);

        const json = await res.json().catch(() => null);
        if (!res.ok) {
          lastErr = { status: res.status, body: json };
          console.error("[assistant-api] upstream error", lastErr);
          // retry once for 5xx
          if (res.status >= 500 && attempt === 1) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
            continue;
          }
          return jsonResponse({ error: json?.error ?? `Upstream error (status ${res.status})` }, 502);
        }

        // Expect OpenAI-like response { choices: [ { message: { content } } ] }
        const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
        const reply = choice?.message?.content ?? (json?.choices?.[0]?.text ?? null);
        if (!reply) {
          console.error("[assistant-api] no reply in upstream response", { json });
          return jsonResponse({ error: "Upstream returned no reply" }, 502);
        }

        return jsonResponse({ data: { reply } }, 200);
      } catch (err) {
        console.error("[assistant-api] fetch attempt failed", { attempt, err });
        lastErr = err;
        if (attempt === 1) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }

    console.error("[assistant-api] all attempts failed", lastErr);
    return jsonResponse({ error: "Failed to call text generation service" }, 502);
  } catch (err) {
    console.error("[assistant-api] unexpected error", err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

console.log("Hello from Functions!")

Deno.serve(async (req) => {
  const { name } = await req.json()
  const data = {
    message: `Hello ${name}!`,
  }

  return new Response(
    JSON.stringify(data),
    { headers: { "Content-Type": "application/json" } },
  )
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/assistant-api' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
