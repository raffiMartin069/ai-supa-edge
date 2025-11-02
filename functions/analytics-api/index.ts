// Analytics API
// - Accepts analytics payloads (records/context) from the application
// - Builds a Philippines / Barangay / LGU focused analysis prompt (health, maternal/child, barangay concerns, blotter)
// - Calls a configured third-party AI (GROQ/OpenAI-compatible) to analyze the data and produce insights
// - Returns structured insights: { insights: string, recommendations: string[], actions: string[] }
//
// Environment variables:
// - GROQ_API_KEY (or the API key for the configured provider)
// - GROQ_URL (optional override, defaults to GROQ endpoint)
// - ANALYTICS_MODEL (optional model id)
// - ANALYTICS_PROVIDER (optional, e.g., 'groq' or 'openai')

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const ANALYTICS_PROVIDER = Deno.env.get("ANALYTICS_PROVIDER") ?? "groq";
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_URL = Deno.env.get("GROQ_URL") ?? DEFAULT_GROQ_URL;
const ANALYTICS_MODEL = Deno.env.get("ANALYTICS_MODEL") ?? "gpt-4o-mini";

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

// Helper: truncate long string to roughly n characters without cutting mid-word
function truncateText(s: string, n = 2000) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "...";
}

// Build a focused prompt for Barangay-level insights
function buildPrompt(records: unknown[], metadata: Record<string, unknown> | null): string {
  const header = `You are an experienced public health and local government analyst specializing in Philippine barangay-level operations.\nProvide concise, evidence-informed, and practical insights and recommendations focused on child & maternal health, barangay concerns, and blotter issues.\nBe culturally sensitive and reference relevant LGU actions where applicable.\n`;

  const metaStr = metadata ? `Metadata: ${JSON.stringify(metadata)}\n` : "";

  // Summarize records (truncate if too long)
  const sample = records.length > 0 ? records.map((r, i) => `Record ${i + 1}: ${truncateText(JSON.stringify(r), 800)}`).join("\n\n") : "No records provided.";

  const guidance = `
  Before answering, work through this step-by-step:
    1. UNDERSTAND: What is the core question being asked?
    2. ANALYZE: What are the key factors/components involved?
    3. REASON: What logical connections can I make?
    4. SYNTHESIZE: How do these elements combine?
    5. CONCLUDE: What is the most accurate/helpful response?

  Now answer:

  When writing insights, do the following:
    1) Provide a short summary (3-5 sentences) of the dataset and immediate concerns.
    2) Highlight up to 5 key patterns or risk signals relevant to child/maternal health, common barangay service needs, and blotter/safety issues.
    3) Provide practical recommendations the barangay can implement in the next 7, 30, and 90 days (use bullet lists).
    4) Identify data gaps and suggested next steps for better monitoring (what additional data to collect).
    5) When applicable, suggest stakeholders to involve (e.g., health center, barangay health workers, police, social welfare).
    6) Keep responses concise and actionable; return result as three sections: INSIGHTS, RECOMMENDATIONS, ACTIONS.
`;

  // Force JSON output instruction (helps reliable parsing)
  const jsonInstruction = `IMPORTANT: Return ONLY a single JSON object as the entire response, and nothing else. The JSON object MUST have the following keys:\n  - "insights": a short string summary (3-5 sentences)\n  - "recommendations": an array of short strings (each a practical recommendation)\n  - "actions": an array of short strings (each a concrete action or stakeholder task)\n\n  Example:\n  { "insights": "...", "recommendations": ["..."], "actions": ["..."] }\n\n  Do NOT include any additional text before or after the JSON. Do NOT wrap the JSON in markdown or backticks.`;

  return `${header}\n${metaStr}\nDataset (sample records):\n${sample}\n\n${guidance}\n\n${jsonInstruction}`;
}

Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object" || !payload.data) {
      return jsonResponse({ error: "Request must be JSON with top-level 'data' containing { records: [...] }" }, 400);
    }

    const data = payload.data as Record<string, unknown>;
    const records = Array.isArray(data.records) ? data.records : [];
    const metadata = data.metadata && typeof data.metadata === "object" ? (data.metadata as Record<string, unknown>) : null;

    if (records.length === 0) {
      return jsonResponse({ error: "No records provided in data.records" }, 400);
    }

    console.info("[analytics-api] received records", { count: records.length, provider: ANALYTICS_PROVIDER });

    const prompt = buildPrompt(records, metadata);

    const requestBody = {
      model: ANALYTICS_MODEL,
      messages: [
        { role: "system", content: "You are a concise public health and local government analyst." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 800
    };

    if (!GROQ_API_KEY) {
      console.error("[analytics-api] GROQ_API_KEY not configured");
      return jsonResponse({ error: "Server not configured (missing GROQ_API_KEY)" }, 500);
    }

    // call upstream provider with one retry for transient errors
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetchWithTimeout(GROQ_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(requestBody)
        }, 30000);

        const json = await res.json().catch(() => null);
        if (!res.ok) {
          console.error("[analytics-api] upstream returned error", { status: res.status, body: json });
          if (res.status >= 500 && attempt === 1) {
            await new Promise((r) => setTimeout(r, 400 * attempt));
            continue;
          }
          return jsonResponse({ error: json?.error ?? `Upstream error (status ${res.status})` }, 502);
        }

        // Map OpenAI/Groq-like response
        const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
        const reply = choice?.message?.content ?? (json?.choices?.[0]?.text ?? null);
        if (!reply) {
          console.error("[analytics-api] upstream returned no reply", { json });
          return jsonResponse({ error: "Upstream returned no reply" }, 502);
        }

        // Try to parse the reply into structured sections: INSIGHTS, RECOMMENDATIONS, ACTIONS
        const parsed = parseAssistantReply(String(reply));
        return jsonResponse({ data: { insights: parsed.insights, recommendations: parsed.recommendations, actions: parsed.actions, provider_response: json } }, 200);
      } catch (err) {
        console.error("[analytics-api] fetch attempt failed", { attempt, err });
        lastErr = err;
        if (attempt === 1) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }

    console.error("[analytics-api] all attempts failed", lastErr);
    return jsonResponse({ error: "Failed to call analytics provider" }, 502);
  } catch (err) {
    console.error("[analytics-api] unexpected error", err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// --- Post-processing: parse assistant free-text reply into structured lists ---
function parseAssistantReply(text: string): { insights: string; recommendations: string[]; actions: string[] } {
  const out = { insights: text.trim(), recommendations: [] as string[], actions: [] as string[] };

  // 1) Try to find a JSON object in the reply and parse
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const candidate = text.slice(firstBrace, lastBrace + 1);
    try {
      const js = JSON.parse(candidate);
      if (js) {
        if (typeof js === "object") {
          out.insights = typeof js.insights === "string" ? js.insights : out.insights;
          if (Array.isArray(js.recommendations)) out.recommendations = js.recommendations.map(String);
          if (Array.isArray(js.actions)) out.actions = js.actions.map(String);
          return out;
        }
      }
    } catch (_e) {
      // ignore JSON parse errors and fall back to regex parsing
    }
  }

  // 2) Regex-based section extraction
  const sec = (name: string) => new RegExp(`${name}[:\\s]*([\\s\\S]*?)(?=(RECOMMENDATIONS:|ACTIONS:|$))`, "i");
  const insightsMatch = text.match(sec("INSIGHTS"));
  const recMatch = text.match(new RegExp(`RECOMMENDATIONS[:\\s]*([\\s\\S]*?)(?=(ACTIONS:|INSIGHTS:|$))`, "i"));
  const actionsMatch = text.match(new RegExp(`ACTIONS[:\\s]*([\\s\\S]*?)(?=(RECOMMENDATIONS:|INSIGHTS:|$))`, "i"));

  if (insightsMatch && insightsMatch[1]) out.insights = insightsMatch[1].trim();
  if (recMatch && recMatch[1]) out.recommendations = extractListItems(recMatch[1]);
  if (actionsMatch && actionsMatch[1]) out.actions = extractListItems(actionsMatch[1]);

  // 3) If no explicit sections found, attempt to heuristically extract numbered/bullet lists
  if (out.recommendations.length === 0) {
    const recHeu = extractHeuristicList(text, /(recommend|suggest|recommendation)/i);
    if (recHeu.length) out.recommendations = recHeu;
  }
  if (out.actions.length === 0) {
    const actHeu = extractHeuristicList(text, /(action|next step|implement)/i);
    if (actHeu.length) out.actions = actHeu;
  }

  // Trim and dedupe
  out.recommendations = Array.from(new Set(out.recommendations.map((s) => s.trim()))).filter(Boolean);
  out.actions = Array.from(new Set(out.actions.map((s) => s.trim()))).filter(Boolean);

  return out;
}

function extractListItems(block: string): string[] {
  const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const items: string[] = [];
  for (const line of lines) {
    // bullets or numbered
    const m = line.match(/^[-*•]\s*(.*)$/) || line.match(/^\d+[.)]\s*(.*)$/);
    if (m) items.push(m[1].trim());
    else if (line.length > 20) items.push(line); // long line, take as item
  }
  return items;
}

function extractHeuristicList(text: string, keywordRegex: RegExp): string[] {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim());
  for (const p of paragraphs) {
    if (keywordRegex.test(p)) {
      const items = extractListItems(p);
      if (items.length) return items;
    }
  }
  return [];
}

