#!/usr/bin/env bash
set -eu

# Usage: set FUNCTION_BASE_URL to your Supabase Functions base URL
# Example: export FUNCTION_BASE_URL="https://<project>.functions.supabase.co"

FUNCTION_BASE_URL="${FUNCTION_BASE_URL:-https://<project>.functions.supabase.co}"

echo "Using FUNCTION_BASE_URL=$FUNCTION_BASE_URL"

HTTP_HEADERS=( -H "Content-Type: application/json" )

echo "\n1) Testing chat-api"
curl -s -X POST "$FUNCTION_BASE_URL/chat-api" "${HTTP_HEADERS[@]}" -d '{"query":"How do I request a barangay ID?"}' | jq -C . || true

echo "\n2) Testing embedding-api (single question, debug)"
curl -s -X POST "$FUNCTION_BASE_URL/embedding-api?debug=true" "${HTTP_HEADERS[@]}" -d '{"data":{"question":"Where is the barangay hall located?"}}' | jq -C . || true

echo "\n3) Testing gemini-assistant"
curl -s -X POST "$FUNCTION_BASE_URL/gemini-assistant" "${HTTP_HEADERS[@]}" -d '{"data":{"query":"Magpaano magkuha ng barangay clearance?"}}' | jq -C . || true

echo "\n4) Testing assistant-api (GROQ fallback)"
curl -s -X POST "$FUNCTION_BASE_URL/assistant-api" "${HTTP_HEADERS[@]}" -d '{"data":{"query":"How do I request a barangay clearance?"}}' | jq -C . || true

echo "\n5) Testing faqs-api (list or sample)"
curl -s -X GET "$FUNCTION_BASE_URL/faqs-api" | jq -C . || true

echo "\n6) Testing analytics-api (post event)"
curl -s -X POST "$FUNCTION_BASE_URL/analytics-api" "${HTTP_HEADERS[@]}" -d '{"event":"smoke_test","source":"scripts/smoke_tests.sh"}' | jq -C . || true

echo "\n7) Upload API placeholder (if enabled)"
echo "Use the following example to upload a file (adjust field names as needed):"
echo "curl -X POST '$FUNCTION_BASE_URL/upload-api' -F 'file=@/path/to/doc.pdf' -H 'Authorization: Bearer <SERVICE_KEY>'"

echo "\nSmoke tests complete. If you deployed functions to a different domain, set FUNCTION_BASE_URL and re-run."
