**Project Overview**

- **Purpose**: This repository contains a set of lightweight Supabase Edge Functions (Deno + TypeScript) implementing an assistant platform for a local LGU (barangay) use case. The functions handle upload → embedding → retrieval → generation with provider fallbacks, observability, and caching.
- **Runtime**: Deno + TypeScript, deployed as Supabase Functions (edge runtime).
- **Location**: The functions live under the `functions/` folder (for example: `functions/chat-api`, `functions/embedding-api`, `functions/gemini-assistant`, `functions/assistant-api`).

**Quick Features**

- **Provider pattern**: Embeddings and text generation are decoupled via providers. Gemini is used (when configured) via REST; GROQ/OpenAI-compatible endpoints act as fallback.
- **Multilingual**: `gemini-assistant` handles language detection and replies in the detected language; `assistant-api` is a GROQ-only English fallback.
- **Observability**: Provider responses are previewed in logs, successful responses include a `meta` object, and generator endpoints include `X-Model-Used`/`X-Model-Id` headers where applicable.
- **Caching**: In-memory embedding cache for warm invocations with configurable TTL.
- **Defensive parsing**: Extractors and normalizers handle varied provider response shapes and ensure stable text output.

**Repository Layout (important paths)**

- `functions/` — edge functions folder
  - `chat-api/` — orchestrates embedding lookup, DB match, and assistant calls (`index.ts`)
  - `assistant-api/` — GROQ-only assistant fallback (`index.ts`)
  - `gemini-assistant/` — Gemini-first multilingual assistant (`index.ts`)
  - `embedding-api/` — embedding provider abstraction, batching, retries (`index.ts`)
  - `upload-api/` — ingestion + text extraction (`index.ts`)
  - `faqs-api/` — FAQ CRUD for content used as context (`index.ts`)
  - `analytics-api/` — simple event capture (`index.ts`)
  - `_shared/` — shared helpers (e.g. `cors.ts`)

**How the main chat flow works**

1. Client POSTs `{ "query": "..." }` to `POST /functions/chat-api`.
2. `chat-api` requests an embedding from `embedding-api` (caching + batching), then calls a DB RPC `match_faq_entries` to fetch top matches.
3. `chat-api` forwards `{ query, context, matches }` to `gemini-assistant` first. If Gemini fails or returns no reply, `chat-api` falls back to `assistant-api` (GROQ).
4. The assistant returns validated text and `meta`. The client receives `{ reply: "..." }`.

**Endpoints & Example Requests**

- Chat:
  - `POST /functions/chat-api`
    - Body: `{"query":"How do I get a barangay ID?"}`
- Embeddings:
  - `POST /functions/embedding-api` with single question:
    - Body: `{"data":{"question":"My query"}}`
  - Batch sheet:
    - Body: `{"data":{"sheet":[{"question":"Q","answer":"A"}], "id":"document-id"}}`
  - Debug mode: append `?debug=true` to function URL or set env `EMBEDDING_DEBUG=true` to log full parsed payload.
- Assistant:
  - `POST /functions/gemini-assistant` — Gemini-first multilingual assistant
  - `POST /functions/assistant-api` — GROQ-only English assistant (fallback)

Example cURL (chat):

```bash
curl -s -X POST "https://<project>.functions.supabase.co/chat-api" \
  -H "Content-Type: application/json" \
  -d '{"query":"How to request a barangay clearance?"}'
```

**Environment Variables (selected)**

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — Supabase runtime keys
- `EMBEDDING_PROVIDER` — `hf` | `http-adapter` | `mock` (default `hf`)
- `HF_URL`, `HF_KEY` — Hugging Face or adapter URL/key
- `ADAPTER_URL`, `ADAPTER_KEY`, `ADAPTER_KEY_HEADER`, `ADAPTER_KEY_PREFIX` — HTTP adapter config
- `EMB_BATCH_SIZE`, `EMB_RETRIES`, `EMB_RETRY_BACKOFF_MS`, `EMBEDDING_CACHE_TTL_MS`
- `EMBEDDING_DEBUG` — set to `true` to log full parsed payloads
- `GEMINI_MODEL`, `GEMINI_API_KEY`, `GROQ_URL`, `GROQ_API_KEY`, `ASSISTANT_MODEL`
- `MATCH_THRESHOLD`, `MATCH_COUNT`, `MAX_CONTEXT_CHARS`, `ENABLE_TEXT_FALLBACK`

**Observability & Debugging**

- Functions log structured messages. Key logs include provider previews (truncated), per-chunk success/failure, and debug payloads when debug mode is enabled.
- Successful embedding responses include a `meta` object with provider info and short previews.
- Use `EMBEDDING_DEBUG=true` or `?debug=true` on `embedding-api` to enable verbose payload logging (dev-only).

**Development**

- Type-check locally with Deno:
  - `deno check --no-config functions/*.ts`
- Deploy functions with the Supabase CLI:
  - `supabase functions deploy <function-name> --no-verify-jwt`

**Security & Privacy**

- Keep provider API keys in environment variables — do not commit secrets.
- Debug logs can contain sensitive data; enable only in secure/dev environments.

**Recommended Next Steps**

- Add an `import_map.json` to pin unversioned imports and silence `deno lint` warnings.
- Add unit tests for `extractText` and `normalizeReply` utilities.
- Optionally add a `VERBOSE_PROVIDER` env toggle for richer provider debugging in staging.

**Smoke test scripts**

- See `scripts/smoke_tests.sh` for example curl commands to exercise each function.

---

If you want, I can also add CI steps, a test harness, or propagate `meta` through the full chat flow.
