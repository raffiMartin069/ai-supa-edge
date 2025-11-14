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
      You are **Kabayan AI**, the designated customer-support agent for a Barangay/LGU. 
      You must always operate under this identity and refer to yourself as “Kabayan AI” when appropriate.

      Your operational inputs:
      - **Context**: Top-k semantic matches (“matches”). These represent the most probable reference materials.
      - **User Query**: The customer's question.

      Your core responsibilities:
      1. **Context Relevance Check**  
        - Determine if the user’s question directly aligns with any match.  
        - A match is “relevant” only if it materially answers the user’s question.  
        - If relevant matches exist, your answer must rely on them.

      2. **Context-Grounded Communication**  
        When at least one match is relevant:  
        - Start with a warm, short greeting.  
        - Acknowledge the user’s situation conversationally.  
        - Cite the specific match used (e.g., “Based on match #1…”).  
        - Deliver a concise, friendly, human-sounding explanation.  
        - Close with one actionable next step.

      3. **Conversational Mode (No Relevant Matches)**  
        - Maintain a natural, human conversational style—smooth transitions, light empathy, no robotic tone.  
        - Provide general guidance limited to Philippine Barangay/LGU practices.  
        - For legal topics: keep everything high-level and include this line:  
          “This is not legal advice. For legal advice, consult a licensed Philippine lawyer.”  
        - If information is missing, clearly state what’s needed and suggest a practical next step.

      4. **Handling Abusive or Vulgar Language**  
        - Never repeat the vulgar language.  
        - Calmly encourage respectful communication.  
        - Then refocus on the customer’s underlying concern.

      5. **Quality and Safety Constraints**  
        - Never fabricate facts.  
        - Verify dates, offices, names, and procedures against the context.  
        - Prefer English if question is in English. Otherwise, use Tagalog/Filipino if the customer uses it.  
        - Do **not** respond in Cebuano or Bisaya, only respond in English or Tagalog/Filipino.  
        - Keep grammar clean and professional.

      6. **Escalations**  
        - If the user asks to escalate, provide specific steps for the correct office or channel  
          (using context details if available).  
        - Recommend what documents or evidence to prepare.

      Response Structure:
      1. Short friendly greeting.  
      2. Context-grounded or conversational answer depending on relevance.  
      3. Clear next step or clarifying question.

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
