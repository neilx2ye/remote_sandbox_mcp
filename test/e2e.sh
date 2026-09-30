#!/usr/bin/env bash
# E2E verification for remote-sandbox-mcp over Streamable HTTP.
set -u
BASE="http://127.0.0.1:8787"
TOKEN="test-token-123"
PASS=0; FAIL=0

check() { # name expected_substring actual
  if echo "$3" | grep -qF "$2"; then
    PASS=$((PASS+1)); echo "PASS  $1"
  else
    FAIL=$((FAIL+1)); echo "FAIL  $1"; echo "  expected to contain: $2"; echo "  got: $(echo "$3" | head -3)"
  fi
}

echo "--- 1. /health ---"
OUT=$(curl -s "$BASE/health")
check "health ok" '"ok":true' "$OUT"

echo "--- 2. wrong token -> 401 ---"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/mcp" \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}')
check "401 on bad token" "401" "$CODE"

echo "--- 3. no token -> 401 ---"
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}')
check "401 on missing token" "401" "$CODE"

echo "--- 4. initialize with correct token ---"
HEADERS=$(mktemp)
OUT=$(curl -s -D "$HEADERS" -X POST "$BASE/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}')
SID=$(grep -i '^mcp-session-id:' "$HEADERS" | tr -d '\r' | awk '{print $2}')
check "initialize result" '"name":"remote-sandbox-mcp"' "$OUT"
if [ -n "${SID:-}" ]; then PASS=$((PASS+1)); echo "PASS  session id present"; else FAIL=$((FAIL+1)); echo "FAIL  session id present"; fi
rm -f "$HEADERS"
echo "  session: $SID"

AUTH=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -H "mcp-session-id: $SID")

call() { # id name args
  curl -s -X POST "$BASE/mcp" "${AUTH[@]}" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$1,\"method\":\"tools/call\",\"params\":{\"name\":\"$2\",\"arguments\":$3}}"
}

echo "--- 5. tools/list ---"
OUT=$(curl -s -X POST "$BASE/mcp" "${AUTH[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')
for T in sys_info fs_list fs_read fs_write fs_edit fs_delete fs_move fs_mkdir fs_search exec_run; do
  check "tools/list has $T" "\"name\":\"$T\"" "$OUT"
done

echo "--- 6. tool calls ---"
OUT=$(call 3 sys_info '{}')
check "sys_info" 'platform' "$OUT"

OUT=$(call 4 fs_write '{"path":"hello.txt","content":"line one\nline two needle\nline three\n"}')
check "fs_write" "Wrote" "$OUT"

OUT=$(call 5 fs_read '{"path":"hello.txt"}')
check "fs_read content" 'line two needle' "$OUT"
check "fs_read line numbers" '2\tline two needle' "$OUT"

OUT=$(call 6 fs_edit '{"path":"hello.txt","edits":[{"oldText":"line one","newText":"LINE ONE"}]}')
check "fs_edit" "Updated hello.txt" "$OUT"

OUT=$(call 7 fs_search '{"pattern":"needle"}')
check "fs_search" 'hello.txt:2:' "$OUT"

OUT=$(call 8 fs_list '{"path":"."}')
check "fs_list" "hello.txt" "$OUT"

OUT=$(call 9 fs_mkdir '{"path":"subdir"}')
check "fs_mkdir" "Created directory subdir" "$OUT"

OUT=$(call 10 fs_move '{"from":"hello.txt","to":"subdir/moved.txt"}')
check "fs_move" "Moved hello.txt -> subdir/moved.txt" "$OUT"

OUT=$(call 11 exec_run '{"command":"node --version"}')
check "exec_run node --version" "exit code: 0" "$OUT"
check "exec_run version output" "v2" "$OUT"

OUT=$(call 12 exec_run '{"command":"rm -rf /"}')
check "exec_run blocks rm -rf /" "rejected" "$OUT"

OUT=$(call 13 fs_delete '{"path":"subdir","recursive":true}')
check "fs_delete recursive" "Deleted directory subdir" "$OUT"

echo "--- 7. sandbox escapes rejected ---"
OUT=$(call 14 fs_read '{"path":"../package.json"}')
check "escape via .." "escapes sandbox" "$OUT"

OUT=$(call 15 fs_read '{"path":"C:/Windows/win.ini"}')
check "escape via absolute win path" "escapes sandbox" "$OUT"

OUT=$(call 16 fs_read '{"path":"/etc/passwd"}')
check "escape via absolute posix path" "Error" "$OUT"

echo "--- 8. GET without session -> 400 ---"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/mcp" -H "Authorization: Bearer $TOKEN" -H "Accept: text/event-stream")
check "GET no session 400" "400" "$CODE"

echo "--- 9. query-param token auth ---"
OUT=$(curl -s -X POST "$BASE/mcp?token=$TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":99,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}')
check "?token= auth works" '"name":"remote-sandbox-mcp"' "$OUT"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
