// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "./_shared/cors.ts";

// Configuration (env overrides)
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MATCH_THRESHOLD = Number(Deno.env.get("MATCH_THRESHOLD") ?? "0.75");
const MATCH_COUNT = Number(Deno.env.get("MATCH_COUNT") ?? "3");
const EMBEDDING_CACHE_TTL_MS = Number(Deno.env.get("EMBEDDING_CACHE_TTL_MS") ?? "300000"); // 5 minutes
const EMBEDDING_TIMEOUT_MS = Number(Deno.env.get("EMBEDDING_TIMEOUT_MS") ?? "15000");
const RPC_TIMEOUT_MS = Number(Deno.env.get("RPC_TIMEOUT_MS") ?? "5000");
const MAX_CONTEXT_CHARS = Number(Deno.env.get("MAX_CONTEXT_CHARS") ?? "4000");
const ENABLE_TEXT_FALLBACK = (Deno.env.get("ENABLE_TEXT_FALLBACK") ?? "true") === "true";

// Create supabase client once (cheaper than per-request)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Simple in-memory cache for recent embeddings (shared across warm invocations)
type EmbeddingCacheItem = { embedding: number[]; ts: number };
const embeddingCache = new Map<string, EmbeddingCacheItem>();

function nowMs() { return Date.now(); }

async function withTimeout<T>(p: Promise<T>, ms: number, errMsg = "Timed out") {
	return await Promise.race([p, new Promise((_res, rej) => setTimeout(() => rej(new Error(errMsg)), ms))]) as T;
}

async function getEmbeddingForQuery(query: string) {
	const key = query.trim().toLowerCase();
	const cached = embeddingCache.get(key);
	if (cached && nowMs() - cached.ts < EMBEDDING_CACHE_TTL_MS) {
		console.info("[chat-api] embedding cache hit", { key, age_ms: nowMs() - cached.ts });
		return cached.embedding;
	}

	console.info("[chat-api] requesting new embedding", { query_length: query.length });
	const resp = await withTimeout(supabase.functions.invoke("embedding-api", { body: { data: { question: query } } }), EMBEDDING_TIMEOUT_MS, "embedding-api timeout");
	if ((resp as unknown as { error?: unknown }).error) throw (resp as any).error;

	// top-level function response body (may itself be { data: ... })
	let embedResp = (resp as any).data;
	// If the function handler returned { data: <vector> } inside the invoke result, unwrap it:
	if (embedResp && typeof embedResp === "object" && "data" in embedResp) {
		embedResp = embedResp.data;
	}

	// Normalize embedding shape
	let queryEmbedding: unknown = embedResp;
	if (typeof queryEmbedding === "string") {
		try { queryEmbedding = JSON.parse(queryEmbedding as string); } catch (_e) { /* ignore */ }
	}
	if (Array.isArray(queryEmbedding) && Array.isArray((queryEmbedding as unknown[])[0] as unknown[])) {
		queryEmbedding = ((queryEmbedding as unknown[])[0] as unknown[]);
	}
	if (!Array.isArray(queryEmbedding) || typeof (queryEmbedding as unknown[])[0] !== "number") {
		throw new Error("Invalid embedding shape from embedding-api");
	}

	const vector = (queryEmbedding as unknown[]).map((v) => Number(v));
	embeddingCache.set(key, { embedding: vector, ts: nowMs() });
	return vector;
}

async function rpcMatchFaqEntries(queryEmbedding: number[], match_threshold = MATCH_THRESHOLD, match_count = MATCH_COUNT) {
	// Supabase RPC call with a timeout wrapper
	const rpcPromise = (async () => {
		return await supabase.rpc("match_faq_entries", { query_embedding: queryEmbedding, match_threshold, match_count });
	})();
	return await withTimeout(rpcPromise, RPC_TIMEOUT_MS, "match_faq_entries timeout");
}

// Fallback text search: quick ilike on question and answer fields to improve recall when vectors fail
async function fallbackTextSearch(query: string, limit = MATCH_COUNT) {
	const q = `%${query.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
	const { data, error } = await supabase
		.from("faq_entry")
		.select("id, question, answer, document_id, created_at")
		.or(`question.ilike.${q},answer.ilike.${q}`)
		.limit(limit);
	if (error) {
		console.warn("[chat-api] fallback text search error", error);
		return [] as unknown[];
	}
	return Array.isArray(data) ? data as unknown[] : [];
}

/**
 * Chat API
 * - Validates user input
 * - Calls `embedding-api` to get an embedding for the query
 * - Calls DB RPC `match_faq_entries` to fetch top matches
 * - Forwards { query, context, matches } to `assistant-api` (Supabase Function)
 * - Returns assistant reply
 *
 * This function intentionally does NOT call any third-party LLM provider directly.
 */

Deno.serve(async (req: Request) => {
	if (req.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: { ...corsHeaders, "Content-Length": "0" } });
	}

	const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "");

	try {
		const body = await req.json().catch(() => null);
		if (!body || typeof body !== "object") {
			return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}

		const query = String((body as Record<string, unknown>).query ?? "").trim();
		if (!query) {
			return new Response(JSON.stringify({ error: "Missing 'query' field" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}

		console.info("[chat-api] received query", { length: query.length });

		// 1) Request embedding (with cache and timeout)
		let queryEmbedding: number[];
		try {
			queryEmbedding = await getEmbeddingForQuery(query);
		} catch (e) {
			console.error("[chat-api] embedding error", e);
			return new Response(JSON.stringify({ error: "Failed to generate embedding" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}

		console.info("[chat-api] embedding ready", { length: queryEmbedding.length });

		// 2) Query DB for matches (with timeout)
		let rpcResult: unknown = null;
		let rpcErr: unknown = null;
		try {
			rpcResult = await rpcMatchFaqEntries(queryEmbedding, MATCH_THRESHOLD, MATCH_COUNT);
			rpcErr = (rpcResult as Record<string, unknown>)?.error ?? null;
		} catch (e) {
			console.error("[chat-api] match_faq_entries rpc error", e);
			rpcErr = e;
		}
		let matches: unknown = null;
		if (!rpcErr && rpcResult && (rpcResult as Record<string, unknown>).data) {
			matches = (rpcResult as Record<string, unknown>).data;
		}
		if (rpcErr || !matches) {
			console.warn("[chat-api] vector search returned no matches or error, attempting text fallback", { rpcErr });
			if (ENABLE_TEXT_FALLBACK) {
				const fallback = await fallbackTextSearch(query, MATCH_COUNT);
				matches = fallback;
			} else {
				matches = [];
			}
		}
		if (rpcErr) {
			console.error("[chat-api] match_faq_entries rpc error", rpcErr);
			return new Response(JSON.stringify({ error: "Failed to fetch matching FAQ entries" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}

		const matchRows = Array.isArray(matches) ? (matches as unknown[]) : [];
		const context = matchRows
			.map((m: unknown) => {
				const row = m as Record<string, unknown>;
				const q = typeof row.question === "string" ? row.question : String(row.question ?? "");
				const a = typeof row.answer === "string" ? row.answer : String(row.answer ?? "");
				return `${q}\n${a}`;
			})
			.join("\n\n");

		let truncatedContext = context;
		if (truncatedContext.length > MAX_CONTEXT_CHARS) {
			const cut = truncatedContext.slice(0, MAX_CONTEXT_CHARS);
			const lastSpace = cut.lastIndexOf(" ");
			truncatedContext = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "...";
		}

		// 3) First try Gemini-backed assistant, fall back to GROQ assistant if needed
		console.info("[chat-api] calling gemini-assistant first", { matches: matchRows.length, contextLength: context.length });
		let finalReply: unknown = null;
		let geminiMeta: unknown = null;

		try {
			const { data: gemResp, error: gemErr } = await supabase.functions.invoke("gemini-assistant", { body: { data: { query, context: truncatedContext, matches: matchRows } } });
			if (gemErr) {
				console.error("[chat-api] gemini-assistant invoke error", gemErr);
			} else if (!gemResp) {
				console.warn("[chat-api] gemini-assistant returned no response", gemResp);
			} else {
				// gemResp may be { data: { reply, meta } } or raw reply; handle both
				const gemData = (gemResp as any).data ?? gemResp;
				let maybeReply: unknown = null;
				if (gemData && typeof gemData === "object") maybeReply = (gemData.reply ?? gemData);
				else maybeReply = gemData;

				if (maybeReply) {
					finalReply = maybeReply;
					if (gemData && typeof gemData === "object") geminiMeta = gemData.meta ?? null;
				} else {
					console.warn("[chat-api] gemini-assistant returned empty reply", gemResp);
				}
			}
		} catch (e) {
			console.error("[chat-api] gemini-assistant error", e);
		}

		if (!finalReply) {
			console.info("[chat-api] falling back to assistant-api", { matches: matchRows.length });
			const { data: assistantResp, error: assistantErr } = await supabase.functions.invoke("assistant-api", { body: { data: { query, context: truncatedContext, matches: matchRows } } });
			if (assistantErr) {
				console.error("[chat-api] assistant-api invoke error", assistantErr);
				return new Response(JSON.stringify({ error: "Assistant service failed" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
			}
			if (!assistantResp) {
				console.error("[chat-api] assistant-api returned no response", assistantResp);
				return new Response(JSON.stringify({ error: "Assistant service returned no data" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
			}

			finalReply = assistantResp.data?.reply ?? assistantResp.data ?? null;
			if (!finalReply) {
				console.error("[chat-api] assistant-api returned empty reply", assistantResp);
				return new Response(JSON.stringify({ error: "Assistant returned empty reply" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
			}
		} else {
			console.info("[chat-api] gemini-assistant succeeded", { geminiMeta });
		}

		const replyOut = typeof finalReply === "string" ? finalReply : JSON.stringify(finalReply);
		return new Response(JSON.stringify({ reply: replyOut }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
	} catch (err: unknown) {
		console.error("[chat-api] unexpected error", err);
		return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
	}
});
