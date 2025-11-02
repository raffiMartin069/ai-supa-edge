// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.
// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Client as PostgresClient } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
// --- Helpers ---------------------------------------------------------------
function jsonResponse(obj: unknown, status = 200): Response {
    return new Response(JSON.stringify(obj), {
        headers: { "Content-Type": "application/json" },
        status,
    });
}

function badRequest(message: string): Response {
    console.warn(`[upload-api] 400 ${message}`);
    return jsonResponse({ error: message }, 400);
}

function serverError(message: string): Response {
    console.error(`[upload-api] 500 ${message}`);
    return jsonResponse({ error: message }, 500);
}
function isExcelFilename(name?: string): boolean {
    if (!name) return false;
    const n = name.toLowerCase();
    return n.endsWith(".xls") || n.endsWith(".xlsx") || n.includes("excel");
}

function sanitizeText(v: unknown): string {
    if (v === null || v === undefined) return "";
    let s = String(v);
    s = s.replace(/\s+/g, " ").trim();
    s = Array.from(s)
        .filter((ch) => {
            const code = ch.charCodeAt(0);
            return code >= 32 && code !== 127;
        })
        .join("");
    return s;
}

function normalizeHeader(h: string): string {
    return h.trim().toLowerCase();
}
// --- Main ------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
        const supabase: SupabaseClient = createClient(supabaseUrl, supabaseKey);

        const contentType = req.headers.get("content-type") ?? "";
        let fileName: string | undefined;
        let fileBytes: Uint8Array | undefined;
        let uploadedBy: string | null = null;

        if (contentType.includes("application/json")) {
            const body = await req.json().catch(() => null);
            if (!body || typeof body !== "object") return badRequest("Invalid JSON body");
            const b = body as Record<string, unknown>;
            fileName = (b.fileName || b.file_name || b.title) as string | undefined;
            const base64 = (b.fileData || b.file_data || b.fileBase64 || b.file) as string | undefined;
            uploadedBy = (b.uploaded_by || b.uploadedBy) as string | null || null;
            if (!fileName || !base64) return badRequest("JSON payload must include 'fileName' and base64 'fileData'");
            try {
                const binary = atob(base64 as string);
                const len = binary.length;
                const bytes = new Uint8Array(len);
                for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
                fileBytes = bytes;
            } catch (_e) {
                return badRequest("fileData is not valid base64");
            }
        } else if (contentType.includes("multipart/form-data") || contentType.includes("form-data")) {
            const form = await req.formData();
            const f = form.get("file");
            uploadedBy = String(form.get("uploaded_by") || form.get("uploadedBy") || "") || null;
            if (f && (f as File).name) {
                const file = f as File;
                fileName = file.name;
                const ab = await file.arrayBuffer();
                fileBytes = new Uint8Array(ab);
            } else {
                fileName = String(form.get("fileName") || form.get("file_name") || "") || undefined;
                const base64 = String(form.get("fileData") || form.get("file_data") || "") || undefined;
                if (fileName && base64) {
                    try {
                        const binary = atob(base64 as string);
                        const len = binary.length;
                        const bytes = new Uint8Array(len);
                        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
                        fileBytes = bytes;
                    } catch (_e) {
                        return badRequest("fileData is not valid base64");
                    }
                }
            }
        } else {
            return badRequest("Unsupported Content-Type. Use multipart/form-data or application/json");
        }

        if (!fileName || !fileBytes) return badRequest("No file uploaded");
        if (!isExcelFilename(fileName)) return badRequest("Uploaded file must be an Excel file with .xls or .xlsx extension");

        let workbook: XLSX.WorkBook;
        try {
            workbook = XLSX.read(fileBytes, { type: "array" });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return badRequest("Failed to parse Excel file: " + msg);
        }

        const sheetName = workbook.SheetNames?.[0];
        if (!sheetName) return badRequest("Excel file contains no sheets");

        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" }) as Record<string, unknown>[];
        if (!Array.isArray(rows) || rows.length === 0) return badRequest("Excel sheet contains no rows");

        const firstRow = rows[0];
        const rawHeaders = Object.keys(firstRow);
        const normalized = rawHeaders.map((h) => normalizeHeader(String(h)));
        const headerSet = new Set(normalized);
        const expected = ["question", "answer"];
        if (headerSet.size !== expected.length || !expected.every((h) => headerSet.has(h))) {
            return badRequest("Excel headers must contain exactly two columns: 'question' and 'answer' (case-insensitive)");
        }

        const headerMap: Record<string, string> = {};
        for (const h of rawHeaders) headerMap[h] = normalizeHeader(h);

        type Entry = { question: string; answer: string };
        const entries: Entry[] = [];
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let qv: unknown = "";
            let av: unknown = "";
            for (const k of Object.keys(row)) {
                const nk = headerMap[k];
                if (nk === "question") qv = row[k];
                if (nk === "answer") av = row[k];
            }
            const question = sanitizeText(qv);
            const answer = sanitizeText(av);
            if (!question) return badRequest(`Row ${i + 2} is missing a question`);
            if (!answer) return badRequest(`Row ${i + 2} is missing an answer`);
            entries.push({ question, answer });
        }

        // Call embedding API BEFORE inserting to obtain embeddings for the entries.
        console.info(`[upload-api] requesting embeddings for ${entries.length} entries`);
        const { data: embedResult, error: embedError } = await supabase.functions.invoke("embedding-api", {
            body: { data: { sheet: entries } },
        });
        if (embedError) {
            const msg = embedError.message ?? "Embedding API error";
            return serverError(String(msg));
        }
        if (!embedResult || !embedResult.data) return serverError("No data returned from embedding API");
        const embeddings = embedResult.data as unknown[];

        // Now perform a transactional insert using direct Postgres connection for atomicity
        const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL") ?? "";
        if (!DATABASE_URL) return serverError("SUPABASE_DB_URL is required for transactional insert");
        const client = new PostgresClient(DATABASE_URL);
        try {
            await client.connect();
            await client.queryArray("BEGIN");
            // Delete existing data (replace behavior requested)
            await client.queryArray("DELETE FROM public.faq_entry;");
            await client.queryArray("DELETE FROM public.faq_document;");
            // Insert document and retrieve id
            const insertDocRes = await client.queryObject({
                text: "INSERT INTO public.faq_document (title, uploaded_at, uploaded_by, total_faqs) VALUES ($1, $2, $3, $4) RETURNING id;",
                args: [fileName, new Date().toISOString(), uploadedBy ?? null, entries.length],
            });
            if (!insertDocRes || !insertDocRes.rows || insertDocRes.rows.length === 0) {
                await client.queryArray("ROLLBACK");
                throw new Error("Failed to insert document (no id returned)");
            }
            const documentId = (insertDocRes.rows[0] as Record<string, unknown>)["id"];
            // Insert entries with embeddings
            for (let i = 0; i < entries.length; i++) {
                const e = entries[i];
                const embRow = (embeddings[i] as Record<string, unknown>) ?? {};
                const emb = (embRow["embedding"] ?? embRow["vector"]) ?? null;
                await client.queryArray({
                    text: "INSERT INTO public.faq_entry (question, answer, embedding, created_at, document_id) VALUES ($1, $2, $3, $4, $5);",
                    args: [e.question, e.answer, emb ? JSON.stringify(emb) : null, new Date().toISOString(), documentId],
                });
            }
            await client.queryArray("COMMIT");
            return jsonResponse({ id: documentId, title: fileName, uploaded_at: new Date().toISOString(), uploaded_by: uploadedBy ?? null, total_faqs: entries.length }, 200);
        } catch (err) {
            try {
                await client.queryArray("ROLLBACK");
            } catch (_) {
                // ignore
            }
            const msg = err instanceof Error ? err.message : String(err);
            return serverError(msg);
        } finally {
            await client.end();
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return serverError(msg);
    }
});
