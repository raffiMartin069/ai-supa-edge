// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.
// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Embedding API Edge Function
 *
 * Accepts JSON body and returns embeddings.
 * Supported inputs:
 * - { data: { sheet: [ { question, answer }, ... ], id?: <document_id> } }
 *   Returns: [{ question, answer, embedding, document_id }, ...]
 * - { data: { question: "..." } }
 *   Returns: embedding array for the single question (shape depends on HF API)
 *
 * Environment variables:
 * - HF_URL: URL of the embedding service (Hugging Face or other).
 * - HF_KEY: Authorization key for the embedding service.
 *
 * Behavior and guarantees:
 * - Validates payload and returns 400 on malformed input.
 * - Batches embeddings in one request when given multiple inputs (improves efficiency).
 * - Returns 502 when the upstream embedding service fails.
 * - Logs structured messages for observability.
 */

type SheetRow = { question?: string; answer?: string; [k: string]: unknown };

// Canonical embedding type
type Embedding = number[];

// Config
const EMB_BATCH_SIZE = Number(Deno.env.get("EMB_BATCH_SIZE") ?? "32");
const EMB_RETRIES = Number(Deno.env.get("EMB_RETRIES") ?? "2");
const EMB_RETRY_BACKOFF_MS = Number(Deno.env.get("EMB_RETRY_BACKOFF_MS") ?? "300");

const HF_URL = Deno.env.get("HF_URL") ?? "";
const HF_KEY = Deno.env.get("HF_KEY") ?? "";
const EMBEDDING_DEBUG = (Deno.env.get("EMBEDDING_DEBUG") ?? "false") === "true";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function badRequest(msg: string) {
  console.warn("[embedding-api] bad request:", msg);
  return jsonResponse({ error: msg }, 400);
}

function upstreamError(msg: string) {
  console.error("[embedding-api] upstream error:", msg);
  return jsonResponse({ error: msg }, 502);
}

function internalError(msg: string) {
  console.error("[embedding-api] internal error:", msg);
  return jsonResponse({ error: "Internal server error" }, 500);
}

// Small utility to produce a safe, truncated preview of objects for logs
function preview(obj: unknown, maxLen = 800) {
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + "...";
  } catch (_e) {
    try {
      return String(obj).slice(0, maxLen) + "...";
    } catch (_e2) {
      return "[unserializable]";
    }
  }
}

// small helper: fetch with timeout
async function fetchWithTimeout(input: RequestInfo, init: RequestInit = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// Embedding provider abstraction -------------------------------------------------
// Providers implement a simple interface: `getEmbeddings(inputs: string[]): Promise<any[]>`
type EmbeddingProvider = {
  name: string;
  getEmbeddings: (inputs: string[]) => Promise<unknown[]>;
};

const EMBEDDING_PROVIDER = Deno.env.get("EMBEDDING_PROVIDER") ?? "hf";

// HF provider (uses HF_URL and HF_KEY)
const HFProvider: EmbeddingProvider = {
  name: "hf",
  getEmbeddings: async (inputs: string[]) => {
    if (!HF_URL) throw new Error("HF_URL is not configured");
    if (!HF_KEY) throw new Error("HF_KEY is not configured");

    console.info(`[embedding-api] [hf] requesting ${inputs.length} embeddings`);
    const payload = { inputs };
    const res = await fetchWithTimeout(HF_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HF_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }, 20000);

      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        console.error("[embedding-api][hf] invalid JSON from HF", err);
        console.info("[embedding-api][hf] response preview:", preview(await res.text().catch(() => "<no-body>")));
        throw new Error("Invalid response from embedding service");
      }

      // Log provider response preview for observability (truncated)
      try {
        console.info("[embedding-api][hf] provider response", { status: res.status, bodyPreview: preview(body) });
      } catch (_e) {
        /* ignore logging errors */
      }

    if (!res.ok) {
      console.error("[embedding-api][hf] service error", { status: res.status, body });
      const errMsg = typeof body === "object" && body !== null && (body as Record<string, unknown>)["error"]
        ? String((body as Record<string, unknown>)["error"]) : `Embedding service error (status ${res.status})`;
      throw new Error(errMsg);
    }

    const embeddings = Array.isArray(body) ? body : (body && (body as Record<string, unknown>)["data"] as unknown[] | undefined);
    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      console.error("[embedding-api][hf] no embeddings returned", { body });
      throw new Error("No embeddings returned from embedding service");
    }
    return embeddings as unknown[];
  }
};

// Simple mock provider useful for local testing; returns deterministic vectors
const MockProvider: EmbeddingProvider = {
  name: "mock",
  getEmbeddings: (inputs: string[]) => {
    console.info(`[embedding-api][mock] generating ${inputs.length} fake embeddings`);
    // For each input return a simple numeric vector derived from char codes.
    const out = inputs.map((s) => {
      const v = new Array(8).fill(0).map((_, i) => {
        let acc = 0;
        for (let j = i; j < s.length; j += 8) acc += s.charCodeAt(j) || 0;
        return acc / 1000; // scale down
      });
      return v;
    });
    return Promise.resolve(out as unknown[]);
  }
};

const providers: Record<string, EmbeddingProvider> = {
  hf: HFProvider,
  mock: MockProvider,
};

// Generic HTTP adapter provider configuration
const ADAPTER_URL = Deno.env.get("ADAPTER_URL") ?? "";
const ADAPTER_KEY = Deno.env.get("ADAPTER_KEY") ?? "";
const ADAPTER_KEY_HEADER = Deno.env.get("ADAPTER_KEY_HEADER") ?? "Authorization";
const ADAPTER_KEY_PREFIX = Deno.env.get("ADAPTER_KEY_PREFIX") ?? "Bearer ";

const HTTPAdapterProvider: EmbeddingProvider = {
  name: "http-adapter",
  getEmbeddings: async (inputs: string[]) => {
    if (!ADAPTER_URL) throw new Error("ADAPTER_URL is not configured");
    console.info(`[embedding-api][http-adapter] requesting ${inputs.length} embeddings from ${ADAPTER_URL}`);

    const payload = { inputs };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (ADAPTER_KEY) headers[ADAPTER_KEY_HEADER] = `${ADAPTER_KEY_PREFIX}${ADAPTER_KEY}`;

    const res = await fetchWithTimeout(ADAPTER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, 20000);

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      console.error("[embedding-api][http-adapter] invalid JSON from adapter", err);
      console.info("[embedding-api][http-adapter] response preview:", preview(await res.text().catch(() => "<no-body>")));
      throw new Error("Invalid response from adapter service");
    }

    // Log adapter response preview
    try {
      console.info("[embedding-api][http-adapter] provider response", { status: res.status, bodyPreview: preview(body) });
    } catch (_e) {
      /* ignore logging errors */
    }

    if (!res.ok) {
      console.error("[embedding-api][http-adapter] adapter error", { status: res.status, body });
      const errMsg = typeof body === "object" && body !== null && (body as Record<string, unknown>)["error"]
        ? String((body as Record<string, unknown>)["error"]) : `Adapter service error (status ${res.status})`;
      throw new Error(errMsg);
    }

    const embeddings = Array.isArray(body) ? body : (body && (body as Record<string, unknown>)["data"] as unknown[] | undefined);
    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      console.error("[embedding-api][http-adapter] no embeddings returned", { body });
      throw new Error("No embeddings returned from adapter service");
    }
    return embeddings as unknown[];
  }
};

// register new providers
providers["http-adapter"] = HTTPAdapterProvider;

function getProvider(): EmbeddingProvider {
  const p = providers[EMBEDDING_PROVIDER];
  if (!p) throw new Error(`Unknown EMBEDDING_PROVIDER '${EMBEDDING_PROVIDER}'. Available: ${Object.keys(providers).join(",")}`);
  return p;
}

// call selected provider
// lastProviderMeta populated per-call to expose provider debug info
let lastProviderMeta: Record<string, unknown> | null = null;

async function callEmbeddingService(inputs: string[]): Promise<Embedding[]> {
  const provider = getProvider();

  // chunk inputs to avoid huge requests
  const chunks: string[][] = [];
  for (let i = 0; i < inputs.length; i += EMB_BATCH_SIZE) chunks.push(inputs.slice(i, i + EMB_BATCH_SIZE));

  const out: Embedding[] = [];

  for (const chunk of chunks) {
    let attempt = 0;
    let raw: unknown[] | null = null;
    const providerResponsesPreview: string[] = [];
    while (attempt <= EMB_RETRIES) {
      try {
        const resp = await provider.getEmbeddings(chunk);
        raw = Array.isArray(resp) ? resp : (resp as unknown[]);
        try { providerResponsesPreview.push(preview(resp)); } catch (_e) { providerResponsesPreview.push("[preview-failed]"); }
        console.info(`[embedding-api] provider ${provider.name} success`, { chunkSize: chunk.length, returned: Array.isArray(raw) ? raw.length : 0 });
        break;
      } catch (err) {
        attempt++;
        console.warn(`[embedding-api] provider ${provider.name} chunk failed (attempt ${attempt}):`, err instanceof Error ? err.message : String(err));
        if (attempt > EMB_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, EMB_RETRY_BACKOFF_MS * attempt));
      }
    }

    if (!raw) throw new Error("No embeddings returned from provider");

    // normalize each raw embedding into Embedding
    for (const r of raw) {
      const e = normalizeEmbedding(r);
      if (!e) throw new Error("Provider returned invalid embedding shape");
      out.push(e);
    }

    // attach metadata about provider responses for this call
    try {
      lastProviderMeta = { provider: provider.name, chunkIndex: lastProviderMeta && typeof lastProviderMeta.chunkIndex === 'number' ? (lastProviderMeta.chunkIndex as number) + 1 : 0, chunkCount: chunks.length, providerResponsesPreview };
    } catch (_e) {
      lastProviderMeta = { provider: provider.name };
    }
  }

  return out;
}

// Normalize various provider embedding shapes into flat number[]
function normalizeEmbedding(raw: unknown): Embedding | null {
  // if string -> try parse
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { /* keep as-is */ }
  }
  // if object with embedding field
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).embedding)) {
    raw = (raw as Record<string, unknown>).embedding;
  }
  // if nested like [[...]] -> unwrap
  if (Array.isArray(raw) && Array.isArray((raw as unknown[])[0])) {
    raw = (raw as unknown[])[0];
  }
  if (!Array.isArray(raw)) return null;
  const vec: number[] = [];
  for (const v of raw as unknown[]) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    vec.push(n);
  }
  return vec;
}

// Main handler
Deno.serve(async (req: Request) => {
  try {
    const payload = await req.json().catch(() => null);
    const url = new URL(req.url);
    const debugQuery = url.searchParams.get("debug") === "true";
    const debug = debugQuery || EMBEDDING_DEBUG;
    console.info("[embedding-api] received request", { url: req.url, debug });
    if (debug && payload) console.info("[embedding-api] debug payload:", payload);

    if (!payload || typeof payload !== "object" || !payload.data) {
      return badRequest("Request must be JSON with a top-level 'data' object");
    }

    const data = payload.data;

    // Case A: batch sheet provided
    if (typeof data === "object" && Array.isArray(data.sheet)) {
      const sheet = data.sheet as SheetRow[];
      if (sheet.length === 0) return badRequest("'sheet' array is empty");

      // filter valid rows and collect inputs
      const inputs: string[] = [];
      const meta: { question: string; answer: string; document_id?: unknown }[] = [];
      for (const r of sheet) {
        const q = typeof r.question === "string" ? r.question.trim() : "";
        const a = typeof r.answer === "string" ? r.answer.trim() : "";
        if (!q || !a) {
          console.warn("[embedding-api] skipping invalid row (missing question/answer)", r);
          continue;
        }
        inputs.push(q);
        meta.push({ question: q, answer: a, document_id: data.id });
      }

      if (inputs.length === 0) return badRequest("No valid rows with both question and answer found in sheet");

      // call embedding service once for all inputs (returns Embedding[])
      let embeddings: Embedding[];
      try {
        embeddings = await callEmbeddingService(inputs);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return upstreamError(msg);
      }

      // map embeddings back to rows with guaranteed numeric vectors
      const results = meta.map((m, i) => ({ question: m.question, answer: m.answer, embedding: embeddings[i], document_id: m.document_id }));
      return jsonResponse({ data: results, meta: lastProviderMeta }, 200);
    }

    // Case B: single question provided
    if (typeof data === "object" && typeof data.question === "string") {
      const q = data.question.trim();
      if (!q) return badRequest("Question cannot be empty");
      let embeddings: Embedding[];
      try {
        embeddings = await callEmbeddingService([q]);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return upstreamError(msg);
      }
      // return single embedding as a flat numeric vector, include provider meta for debugging
      return jsonResponse({ data: embeddings[0], meta: lastProviderMeta }, 200);
    }

    return badRequest("Unsupported payload. Provide 'data.sheet' (array) or 'data.question' (string)");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return internalError(msg);
  }
});

