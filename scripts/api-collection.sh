#!/usr/bin/env bash
# A runnable curl collection for the OpsDesk API (P-19). It starts a guest session on the LOCAL stack and walks the main endpoints,
# printing each call, its status and the start of its body. It exits non-zero when a status is not the expected one, so it is also a
# smoke test: `src/lib/api/curl-collection.integration.test.ts` runs it against a real production server.
#
#   npm run db:start
#   npm run build && npm run start                      # or `npm run dev`
#   BASE=http://localhost:3000 bash scripts/api-collection.sh
#
# Conventions it shows (docs/API.md, docs/openapi.yaml):
#   - The session is a cookie (`sb-<host>-auth-token`). Mutations must carry an `Origin` header equal to the app's own origin.
#   - The workspace is chosen per request with the `X-Organization-Id` header (a workspace the caller belongs to; otherwise 404).
#   - Every response is `{ data, meta }` or `{ error: { code, message, requestId } }`, and has an `X-Request-Id` header.
#   - Edits carry the version you read (`expectedUpdatedAt`); a stale one is `409 STALE_EDIT`.
# It refuses any Supabase URL that is not local: it signs up an anonymous guest with Cloudflare's public test CAPTCHA token.
set -euo pipefail

BASE=${BASE:-http://localhost:3000}
ORIGIN=${ORIGIN:-$BASE}
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

json() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);process.stdout.write(String(v))"; }

if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_PUBLISHABLE_KEY:-}" ]; then
  STATUS_JSON=$(node scripts/supabase.mjs status -o json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.slice(s.indexOf('{'))))")
  SUPABASE_URL=$(echo "$STATUS_JSON" | json 'o.API_URL')
  SUPABASE_PUBLISHABLE_KEY=$(echo "$STATUS_JSON" | json 'o.PUBLISHABLE_KEY')
fi
case "$SUPABASE_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "refused: SUPABASE_URL ($SUPABASE_URL) is not the local stack" >&2; exit 2 ;;
esac

echo "== 1. a guest session (Supabase Auth: anonymous sign-in with the public test CAPTCHA token)"
SESSION=$(curl -sS -X POST "$SUPABASE_URL/auth/v1/signup" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H 'Content-Type: application/json' \
  --data '{"gotrue_meta_security":{"captcha_token":"XXXX.DUMMY.TOKEN.XXXX"}}')
COOKIE=$(echo "$SESSION" | node -e "
const s=require('fs').readFileSync(0,'utf8');
const host=new URL('$SUPABASE_URL').hostname.split('.')[0];
process.stdout.write('sb-'+host+'-auth-token=base64-'+Buffer.from(s).toString('base64url'))")
ORG=""
EXTRA=()

call() { # call METHOD PATH [JSON-BODY] -> sets STATUS and BODY
  local method=$1 path=$2 data=${3:-}
  local args=(-sS -X "$method" "$BASE/api/v1$path" -H "Cookie: $COOKIE" -H "Origin: $ORIGIN" -o "$TMP" -w '%{http_code}')
  [ -n "$ORG" ] && args+=(-H "X-Organization-Id: $ORG")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' --data "$data")
  [ ${#EXTRA[@]} -gt 0 ] && args+=("${EXTRA[@]}")
  STATUS=$(curl "${args[@]}")
  BODY=$(cat "$TMP")
  printf '%s %s -> %s  %s\n' "$method" "$path" "$STATUS" "$(echo "$BODY" | head -c 150 | tr -d '\n')"
}
expect() { if [ "$STATUS" != "$1" ]; then echo "FAILED: expected $1, got $STATUS" >&2; echo "$BODY" >&2; exit 1; fi; }
field() { echo "$BODY" | json "$1"; }

echo; echo "== 2. who am I, and a demo workspace (idempotent: the same key returns the same workspace)"
call GET /session; expect 200
EXTRA=(-H 'Idempotency-Key: collection-bootstrap-1')
call POST /demo/bootstrap; expect 200
ORG=$(field 'o.data.organizationId'); EXTRA=()
echo "workspace: $ORG"

echo; echo "== 3. customers: list, create, read, edit with the version you read, archive, restore"
call GET '/customers?limit=3&sort=display_name&order=asc'; expect 200
call POST /customers '{"displayName":"Curl Collection Co","status":"lead","tags":["curl"]}'; expect 201
CID=$(field 'o.data.id'); VER=$(field 'o.data.updatedAt')
call GET "/customers/$CID"; expect 200
call PATCH "/customers/$CID" "{\"notes\":\"edited from curl\",\"expectedUpdatedAt\":\"$VER\"}"; expect 200
echo "-- the same edit again with the OLD version is a stale edit (409):"
call PATCH "/customers/$CID" "{\"notes\":\"again\",\"expectedUpdatedAt\":\"$VER\"}"; expect 409
call DELETE "/customers/$CID"; expect 204
call POST "/customers/$CID/restore"; expect 200

echo; echo "== 4. an opportunity on that customer, moved along the pipeline"
call POST /opportunities "{\"customerId\":\"$CID\",\"title\":\"Curl deal\",\"amountCents\":250000,\"stage\":\"new\"}"; expect 201
OID=$(field 'o.data.id'); OVER=$(field 'o.data.updatedAt')
call POST "/opportunities/$OID/stage" "{\"stage\":\"qualified\",\"expectedUpdatedAt\":\"$OVER\"}"; expect 200

echo; echo "== 5. a task, then complete it"
call POST /tasks "{\"title\":\"Curl task\",\"customerId\":\"$CID\",\"dueDate\":\"2030-01-01\"}"; expect 201
TID=$(field 'o.data.id'); TVER=$(field 'o.data.updatedAt')
call POST "/tasks/$TID/complete" "{\"completed\":true,\"expectedUpdatedAt\":\"$TVER\"}"; expect 200

echo; echo "== 6. a quote (integer cents; the totals are computed by the server), read back"
EXTRA=(-H 'Idempotency-Key: collection-quote-1')
call POST /quotes "{\"customerId\":\"$CID\",\"title\":\"Curl quote\",\"taxRateBps\":825,\"items\":[{\"description\":\"Work\",\"quantity\":2,\"unitPriceCents\":10000}]}"; expect 201
EXTRA=()
QID=$(field 'o.data.id')
call GET "/quotes/$QID"; expect 200

echo; echo "== 7. dashboard, reports, activity and a CSV export"
call GET /dashboard; expect 200
call GET '/reports?range=30'; expect 200
call GET '/activity?limit=3'; expect 200
call GET /exports/customers; expect 200

echo; echo "== 8. errors share one envelope with a request id"
call GET /customers/00000000-0000-4000-8000-000000000999; expect 404
echo "   error.code=$(field 'o.error.code') requestId=$(field 'o.error.requestId')"
call POST /customers '{"displayName":""}'; expect 422
call GET /no-such-endpoint; expect 404
echo "   unknown path: $(field 'o.error.code')"
echo "-- a mutation from another origin is refused (CSRF check):"
ORIGIN_SAVED=$ORIGIN; ORIGIN=https://evil.example
call POST /customers '{"displayName":"x"}'; expect 403
ORIGIN=$ORIGIN_SAVED

echo; echo "== 9. signed out"
COOKIE_SAVED=$COOKIE; COOKIE=""
call GET /customers; expect 401
COOKIE=$COOKIE_SAVED

echo; echo "collection finished: every call returned the expected status"
