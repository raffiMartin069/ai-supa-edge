# Function-level Developer Documentation

This document provides surgical, step-by-step documentation for the primary edge functions in this repository. The goal is to let a developer quickly understand what each function does, its inputs/outputs, key helper functions, observability points, and common failure modes.

---

## 1) `chat-api`

Purpose

- Orchestrator endpoint for interactive chat. It accepts a user query, obtains an embedding, finds relevant FAQ matches from the database, and asks an assistant function to generate a reply.

High-level steps (surgical)

- Validate incoming request JSON: expect `{ query: string }`.

- Request embedding for `query` by invoking `embedding-api` (cached with in-memory TTL).

- Normalize embedding shape (handle stringified arrays and nested shapes).

- Call DB RPC `match_faq_entries(query_embedding, match_threshold, match_count)` to fetch top-K matches.

  - If RPC errors or returns no matches, optionally run `fallbackTextSearch` which performs an `ilike` search on `faq_entry` table.

- Assemble `context` by joining `question + answer` from returned rows. Truncate `context` to `MAX_CONTEXT_CHARS`.

- Invoke the assistant endpoint flow:

  - Try `gemini-assistant` first (if configured and available) by invoking the Supabase function.

  - If Gemini fails or returns empty, fall back to `assistant-api` (GROQ/OpenAI-like provider).

- Normalize/return the assistant reply as `{ reply: string }`.

Inputs / Outputs

- Input: `{ "query": "..." }` in POST body.

- Output: `{ "reply": "..." }` (JSON) or error JSON with HTTP status codes.

Key configuration / env

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — used to invoke other functions and DB.

- `MATCH_THRESHOLD`, `MATCH_COUNT`, `EMBEDDING_CACHE_TTL_MS`, `MAX_CONTEXT_CHARS`, `ENABLE_TEXT_FALLBACK`.

Observability

- Logs: embedding cache hits, embedding request/response, RPC success/errors, fallback occurrences, `gemini-assistant` invocation and fallback decision.

Failure modes

- Embedding API failure -> returns 502 with message "Failed to generate embedding".

- RPC error -> fallback to text search or return 502 if no fallback.

- Both assistant functions failing -> returns 502 "Assistant service failed".

---

## 2) `embedding-api`

Purpose
 
- Provide embeddings for either a single question or a batch sheet of Q/A rows. It abstracts multiple providers (HF, http-adapter, mock), supports batching, retries, and returns normalized numeric vectors.

High-level steps (surgical)

- Validate incoming payload: expects `data.question` or `data.sheet` (sheet is array of rows with `question` + `answer`).

- If batch (`sheet`) mode:

  - Validate rows, collect `inputs` (questions), maintain `meta` (question/answer/document_id).

  - Call `callEmbeddingService(inputs)` which chunks inputs by `EMB_BATCH_SIZE` and calls provider.getEmbeddings for each chunk with retry/backoff.

  - Normalize each returned shape into a flat `number[]` via `normalizeEmbedding` and attach to each row.

  - Return `{ data: [{ question, answer, embedding, document_id }, ...], meta?: { provider info } }`.

- If single-question mode:

  - Call `callEmbeddingService([question])` and return `{ data: <embedding array>, meta?: { provider info } }`.

Key helpers & behavior

- `callEmbeddingService(inputs)`:

  - Splits input list into chunks by `EMB_BATCH_SIZE`.

  - Calls the configured provider (HF, HTTP adapter, or mock) with retries up to `EMB_RETRIES` and exponential backoff.

  - Accumulates `lastProviderMeta` to provide provider name and short previews for debugging.

- `normalizeEmbedding(raw)`:

  - Accepts strings, nested arrays, or objects with `embedding` field and returns a flat `number[]` or `null` for invalid shapes.

- `preview(obj, maxLen)` helper added for safe truncated logging.

Providers

- `hf` (HF_URL + HF_KEY) — expects the provider to return an array of embeddings or `{ data: [...] }`.

- `http-adapter` (ADAPTER_URL + ADAPTER_KEY) — generic HTTP adapter to proxy to a service.

- `mock` — deterministic local provider for testing.

Inputs / Outputs

- Input (single): `{ data: { question: "..." } }`

- Input (batch): `{ data: { sheet: [ { question, answer }, ... ], id?: <document_id> } }`

- Output (single): `{ data: [<number>, ...], meta?: { provider, providerResponsesPreview } }`

- Output (batch): `{ data: [ { question, answer, embedding, document_id }, ... ], meta?: { ... } }`

Observability

- Logs provider request/response previews (truncated), chunk-level success, and JSON parse errors. When `EMBEDDING_DEBUG=true` or `?debug=true`, logs full parsed payload.

Failure modes

- Provider returns non-array or malformed embeddings -> function returns 502 with upstream error details.

- Adapter/HF network errors -> retries then error out.

---

## 3) `assistant-api` (GROQ fallback)

Purpose
 
- A minimal assistant endpoint that constructs a compact prompt and calls a GROQ/OpenAI-compatible endpoint. It is intentionally English-only and acts as the fallback generation path.

Notes

- This file contains inline surgical documentation in the source (detailed comments explaining each step). It:

  - Validates the payload shape (expects `data.query` and optional `data.context`).

  - Runs the `isContextRelevant` heuristic to mark `Context relevance: YES/NO` in the prompt.

  - Builds a controlled persona prompt (`Kabayan AI`) with strict rules and a required response structure.

  - Calls the configured `GROQ_URL` with `GROQ_API_KEY`.

  - Parses the provider response defensively (supports `choices[0].message.content` and older `choices[0].text`).

  - Returns `{ data: { reply }, meta: { modelUsed: "groq", modelId } }` or a 502 on upstream failure.

Key helpers

- `isContextRelevant(query, context)` — simple token overlap heuristic.

- `fetchWithTimeout` — abort-based wrapper for fetch.


Observability

- Logs truncated request preview, response headers and returns `X-Model-Used` / `X-Model-Id` headers on success.

Failure modes

- Missing `GROQ_API_KEY` -> 500 configuration error.

- Provider errors -> 502 with `meta` showing `modelUsed`.
---

## 4) `gemini-assistant`
 
 
 
 
 
 
High-level steps (surgical)

 

- Detect user language with `detectLanguage(text)` heuristic or model-based detector.
 
- Use `isContextRelevant` to decide context usage.

- Build prompt tailored to the detected language, including persona and rules.

- Call Gemini REST `https://generativelanguage.googleapis.com/v1alpha2/models/{GEMINI_MODEL}:generateContent` using `x-goog-api-key` header.

- Extract text robustly from multiple possible Gemini response shapes via `extractText(value)`.

- Normalize whitespace and remove extra blank lines via `normalizeReply(s)`.

- If Gemini returns invalid or empty result, log `geminiDebug` and fallback to GROQ.

Inputs / Outputs

- Input: `{ data: { query: string, context?: string, matches?: [] } }`

- Output: `{ data: { reply: string }, meta: { modelUsed: 'gemini'|'groq', geminiDebug?: any } }` and headers `X-Model-Used`/`X-Model-Id`.

Observability

- Logs truncated request/response bodies and includes `geminiDebug` in `meta` when extraction fails or the response shape is unexpected.

Failure modes

- Gemini REST 400 error when unsupported fields are present (ensure request body only uses supported fields).

- Network errors -> fallback to GROQ.

---

## 5) `upload-api`

Purpose
 
- Handles ingestion of Excel FAQ sheets (or JSON/base64 payloads), extracts rows, requests embeddings for the rows, and inserts them into the DB transactionally.

High-level steps (surgical)

- Accepts multipart form-data (file upload) or JSON with base64 file.

- Validates file is Excel (.xls/.xlsx) and parses using `xlsx` (Sheet to JSON).

- Validates sheet has exactly two logical columns: `question` and `answer` (case-insensitive).

- Sanitizes text (`sanitizeText`) and builds `entries` list.

- Calls `embedding-api` with `{ data: { sheet: entries } }` to obtain embeddings for every row.

- Opens a direct Postgres transactional client using `SUPABASE_DB_URL` and does:

  - `BEGIN`

  - Delete existing `faq_entry` and `faq_document` rows (replace behavior)

  - Insert document record and retrieve `documentId`

  - Insert each FAQ entry with its embedding (JSON-encoded) and `document_id`

  - `COMMIT`

- Returns `{ id: documentId, title, uploaded_at, uploaded_by, total_faqs }` on success.

Important notes

- This function uses `SUPABASE_DB_URL` and connects directly to Postgres for transactional guarantees. Ensure `SUPABASE_DB_URL` is a service-role URL.

- The function expects the upstream `embedding-api` to return matching embeddings in the same order.

Failure modes

- Excel parsing errors -> 400 with message.

- Embedding API failure -> 500/502 depending on error; aborts the insert.

- DB transaction error -> attempts `ROLLBACK` and returns 500.

---

## 6) `faqs-api`

Purpose

- A small read-only function that returns rows from the `faq_entry` table for debugging and browsing.

Behavior

- Accepts only GET requests. Uses `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_ANON_KEY` to query the `faq_entry` table and returns `id, question, answer, document_id, created_at`.

Failure modes

- Missing DB configuration or DB errors -> 500/502 with error logs.

---

## 7) `analytics-api`

Purpose

- Accepts event/record payloads and asks a configured text generation provider to produce structured insights (INSIGHTS, RECOMMENDATIONS, ACTIONS). This is focused on Philippines and LGU contexts.

High-level steps

- Validate payload contains `data.records` array.

- Build an evidence-driven prompt with explicit instructions to return JSON only (for deterministic parsing).

- Call GROQ/OpenAI-like endpoint with low temperature and parse output.

- Try to parse JSON embedded in the returned text; fall back to regex extraction and heuristics to split sections.

- Return structured object `{ insights, recommendations, actions }`.

Observability

- Logs record counts and provider used. Includes retry attempts for transient upstream failures.

Failure modes

- Provider returns text not containing JSON -> heuristics attempt to recover; if cannot, returns error.

---

## Where to make targeted changes

- If you want better language detection, update `gemini-assistant`'s `detectLanguage` to call a small classification model instead of heuristics.
- To propagate `meta` end-to-end, have `embedding-api` include `meta` in its response and modify `chat-api` to attach it to the final response.
- To improve observability, add a `VERBOSE_PROVIDER` env flag to toggle full provider logging for staging only.

---

If you want these surgical docs converted into JSDoc-style comments inside each source file (so editors and tooling surface them), tell me which functions you prefer inline and I will add JSDoc blocks corresponding to the sections above.
