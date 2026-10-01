#!/usr/bin/env bash
# E2E for multi-project architecture. Runs the server from a THROWAWAY cwd so
# the real project's data/ and sandbox.config.json are never touched.
set -u
PORT=8899
BASE="http://127.0.0.1:$PORT"
ADMIN="admin-e2e-token"
SEED_TOKEN="seed-token-e2e"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0

check() {
  if echo "$3" | grep -qF "$2"; then
    PASS=$((PASS+1)); echo "PASS  $1"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $1"; echo "  expected: $2"; echo "  got: $(echo "$3" | head -3)"
  fi
}

WORK=$(mktemp -d)
ROOT_A="$WORK/root-a"; ROOT_B="$WORK/root-b"
mkdir -p "$ROOT_A" "$ROOT_B"
echo "secret-in-b" > "$ROOT_B/b-only.txt"
# Windows-style paths (forward slashes) for JSON payloads sent to the Node server.
WROOT_A=$(cygpath -m "$ROOT_A")
WROOT_B=$(cygpath -m "$ROOT_B")

echo "workdir: $WORK"
cd "$WORK" || exit 1
node "$APP_DIR/dist/index.js" --port $PORT --token "$SEED_TOKEN" --admin-token "$ADMIN" > server.log 2>&1 &
SRV=$!
sleep 2

ADMIN_H=(-H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json")

echo "--- 1. seed & admin ---"
OUT=$(curl -s "$BASE/health")
check "health ok" '"ok":true' "$OUT"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects")
check "api without admin token -> 401" "401" "$CODE"

OUT=$(curl -s "$BASE/api/projects" "${ADMIN_H[@]}")
check "seeded default project listed" '"slug":"default"' "$OUT"
check "seeded project is the /mcp alias" '"isDefault":true' "$OUT"
check "list masks token" '****' "$OUT"

echo "--- 2. create projects A & B ---"
OUT=$(curl -s -X POST "$BASE/api/projects" "${ADMIN_H[@]}" \
  -d "{\"name\":\"Project Alpha\",\"root\":\"$WROOT_A\"}")
check "create A returns full token" '"token":"' "$OUT"
SLUG_A=$(echo "$OUT" | grep -o '"slug":"[^"]*"' | head -1 | cut -d'"' -f4)
TOKEN_A=$(echo "$OUT" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
ID_A=$(echo "$OUT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
check "slug A derived" 'project-alpha' "$SLUG_A"
check "mcpPath is the project's own /<slug>" '"mcpPath":"/project-alpha"' "$OUT"

OUT=$(curl -s -X POST "$BASE/api/projects" "${ADMIN_H[@]}" \
  -d "{\"name\":\"Project Beta\",\"slug\":\"proj-b\",\"root\":\"$WROOT_B\"}")
TOKEN_B=$(echo "$OUT" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
ID_B=$(echo "$OUT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
check "create B with explicit slug" '"slug":"proj-b"' "$OUT"

echo "--- 3. MCP sessions per project ---"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"1.0"}}}'
HEADERS_FILE="$WORK/h.txt"

init_session() { # endpoint-path token -> echoes session id
  curl -s -D "$HEADERS_FILE" -X POST "$BASE$1" \
    -H "Authorization: Bearer $2" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" -d "$INIT" > /dev/null
  grep -i '^mcp-session-id:' "$HEADERS_FILE" | tr -d '\r' | awk '{print $2}'
}

SID_A=$(init_session "/$SLUG_A" "$TOKEN_A")
SID_B=$(init_session "/proj-b" "$TOKEN_B")
[ -n "$SID_A" ] && PASS=$((PASS+1)) && echo "PASS  session A" || { FAIL=$((FAIL+1)); echo "FAIL  session A"; }
[ -n "$SID_B" ] && PASS=$((PASS+1)) && echo "PASS  session B" || { FAIL=$((FAIL+1)); echo "FAIL  session B"; }

call() { # sid token slug id name args  (empty slug = the shared /mcp alias)
  local mcp_path="/mcp"; [ -n "$3" ] && mcp_path="/$3"
  curl -s -X POST "$BASE$mcp_path" \
    -H "Authorization: Bearer $2" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" -H "mcp-session-id: $1" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$4,\"method\":\"tools/call\",\"params\":{\"name\":\"$5\",\"arguments\":$6}}"
}

OUT=$(call "$SID_A" "$TOKEN_A" "$SLUG_A" 10 fs_write '{"path":"a.txt","content":"owned-by-A"}')
check "A: fs_write" 'Wrote' "$OUT"
OUT=$(call "$SID_A" "$TOKEN_A" "$SLUG_A" 11 fs_read '{"path":"a.txt"}')
check "A: fs_read" 'owned-by-A' "$OUT"
OUT=$(call "$SID_B" "$TOKEN_B" "proj-b" 12 fs_write '{"path":"b.txt","content":"owned-by-B"}')
check "B: fs_write" 'Wrote' "$OUT"

echo "--- 4. isolation ---"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/proj-b" \
  -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -d "$INIT")
check "cross token A->B -> 401" "401" "$CODE"

OUT=$(call "$SID_A" "$TOKEN_A" "$SLUG_A" 13 fs_read "{\"path\":\"$WROOT_B/b-only.txt\"}")
check "A cannot read B's root (abs path)" 'escapes sandbox' "$OUT"
OUT=$(call "$SID_A" "$TOKEN_A" "$SLUG_A" 14 fs_read '{"path":"../root-b/b-only.txt"}')
check "A cannot escape via .." 'escapes sandbox' "$OUT"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/proj-b" \
  -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -H "mcp-session-id: $SID_A" \
  -d '{"jsonrpc":"2.0","id":15,"method":"tools/list","params":{}}')
check "session A reused on slug B -> 403" "403" "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/no-such" \
  -H "Authorization: Bearer $TOKEN_A" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -d "$INIT")
check "unknown slug -> 404" "404" "$CODE"

# The old /mcp/<slug> shape is gone and points callers at /<slug>.
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/mcp/proj-b" \
  -H "Authorization: Bearer $TOKEN_B" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -d "$INIT")
check "legacy /mcp/<slug> -> 404" "404" "$CODE"

echo "--- 5. backward compat: /mcp = assigned project ---"
# /mcp (no slug) -> the project assigned to the shared path (the seeded default)
SID_D=$(init_session "/mcp" "$SEED_TOKEN")
[ -n "$SID_D" ] && PASS=$((PASS+1)) && echo "PASS  /mcp assigned project with seed token" || { FAIL=$((FAIL+1)); echo "FAIL  /mcp assigned project with seed token"; }
OUT=$(call "$SID_D" "$SEED_TOKEN" "" 16 sys_info '{}')
check "default sys_info slug" 'default' "$OUT"

echo "--- 6. admin file browse & preview ---"
OUT=$(curl -s "$BASE/api/projects/$ID_A/files?path=." "${ADMIN_H[@]}")
check "files API lists a.txt" '"name":"a.txt"' "$OUT"
OUT=$(curl -s "$BASE/api/projects/$ID_A/file?path=a.txt" "${ADMIN_H[@]}")
check "preview text" '"kind":"text"' "$OUT"
check "preview content" 'owned-by-A' "$OUT"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/projects/$ID_A/files?path=.." "${ADMIN_H[@]}")
check "files API .. -> 400" "400" "$CODE"
OUT=$(curl -s "$BASE/api/projects/$ID_A" "${ADMIN_H[@]}")
check "detail returns full token" "$TOKEN_A" "$OUT"

echo "--- 7. admin console ---"
OUT=$(curl -s "$BASE/admin")
check "/admin serves HTML" '管理台' "$OUT"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/../../sandbox.config.json")
check "/admin traversal -> 404" "404" "$CODE"

echo "--- 8. audit ---"
OUT=$(grep -c '"project":"'"$SLUG_A"'"' "$WORK/logs/audit.jsonl" || true)
[ "$OUT" -ge 3 ] && PASS=$((PASS+1)) && echo "PASS  audit has project slug ($OUT lines)" || { FAIL=$((FAIL+1)); echo "FAIL  audit project slug (got $OUT)"; }

kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
sleep 1
echo ""
echo "PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  cd / && rm -rf "$WORK"
  echo "cleaned up $WORK"
else
  echo "WORK DIR KEPT FOR DEBUG: $WORK"
fi
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
