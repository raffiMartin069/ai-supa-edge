// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "./_shared/cors.ts";

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

		// 1) Request embedding from embedding-api function
		const { data: embedResp, error: embedErr } = await supabase.functions.invoke("embedding-api", { body: { data: { question: query } } });
		if (embedErr) {
			console.error("[chat-api] embedding-api invoke error", embedErr);
			return new Response(JSON.stringify({ error: "Failed to generate embedding" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}
		if (!embedResp || !embedResp.data) {
			console.error("[chat-api] embedding-api returned no data", embedResp);
			return new Response(JSON.stringify({ error: "Embedding service returned no data" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}
				// Normalize embedding shape: embedding-api may return a JSON string, a nested array [[...]], or [...]
				let queryEmbedding: unknown = embedResp.data;
				if (typeof queryEmbedding === "string") {
					try {
						queryEmbedding = JSON.parse(queryEmbedding as string);
					} catch (err) {
						console.warn("[chat-api] failed to parse embedding string", { err });
					}
				}
				// If it's nested like [[...]] take the first element
						if (Array.isArray(queryEmbedding) && Array.isArray((queryEmbedding as unknown[])[0] as unknown[])) {
							queryEmbedding = ((queryEmbedding as unknown[])[0] as unknown[]);
						}

						if (!Array.isArray(queryEmbedding) || typeof (queryEmbedding as unknown[])[0] !== "number") {
							console.error("[chat-api] embedding has unexpected shape", { example: queryEmbedding });
							return new Response(JSON.stringify({ error: "Invalid embedding shape from embedding-api" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
						}

						console.info("[chat-api] embedding ready", { length: (queryEmbedding as unknown[]).length });

				// 2) Query DB for matches
				const { data: matches, error: rpcErr } = await supabase.rpc("match_faq_entries", { query_embedding: queryEmbedding, match_threshold: 0.75, match_count: 3 });
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

		// 3) Forward query+context to assistant-api function
		console.info("[chat-api] calling assistant-api", { matches: matchRows.length, contextLength: context.length });
		const { data: assistantResp, error: assistantErr } = await supabase.functions.invoke("assistant-api", { body: { data: { query, context, matches: matchRows } } });
		if (assistantErr) {
			console.error("[chat-api] assistant-api invoke error", assistantErr);
			return new Response(JSON.stringify({ error: "Assistant service failed" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}
		if (!assistantResp) {
			console.error("[chat-api] assistant-api returned no response", assistantResp);
			return new Response(JSON.stringify({ error: "Assistant service returned no data" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}

		const reply = assistantResp.data?.reply ?? assistantResp.data ?? null;
		if (!reply) {
			console.error("[chat-api] assistant-api returned empty reply", assistantResp);
			return new Response(JSON.stringify({ error: "Assistant returned empty reply" }), { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } });
		}

		return new Response(JSON.stringify({ reply }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
	} catch (err: unknown) {
		console.error("[chat-api] unexpected error", err);
		return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
	}
});
