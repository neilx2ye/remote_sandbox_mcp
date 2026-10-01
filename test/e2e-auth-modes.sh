#!/usr/bin/env bash
# End-to-end check of the MCP auth modes (any / token / none) against the built
# server: real CLI flags, real HTTP, real fs_read tool call.
#
#   npm run build && bash test/e2e-auth-modes.sh
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
REPO_WIN="$(cygpath -w "$REPO" 2>/dev/null || echo "$REPO")"
FAIL=0

check() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf '  ok   %-52s %s\n' "$1" "$3"
  else printf '  FAIL %-52s got=[%s] want=[%s]\n' "$1" "$3" "$2"; FAIL=1; fi
}

SERVER_PID=""

start_server() { # <mode> <port> <dir>
  if netstat -ano 2>/dev/null | grep -q "LISTENING.*:$2\$"; then
    echo "  FAIL port $2 is already in use by another process"; FAIL=1; return 1
  fi
  ( cd "$3" && exec node "$REPO_WIN/dist/index.js" --port "$2" >"$3/out.log" 2>"$3/err.log" ) &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    curl -s -m 1 -o /dev/null "http://127.0.0.1:$2/health" && return 0
    sleep 0.25
  done
  echo "  FAIL server on port $2 never became healthy"; FAIL=1; return 1
}

stop_server() {
  [ -n "$SERVER_PID" ] || return 0
  kill "$SERVER_PID" 2>/dev/null
  for _ in $(seq 1 30); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.2
  done
  kill -9 "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  SERVER_PID=""
}

run_mode() { # <mode> <port>
  local MODE="$1" PORT="$2"
  local T; T=$(mktemp -d)
  mkdir -p "$T/sandbox"
  printf 'hello from sandbox\n' > "$T/sandbox/hello.txt"
  cat > "$T/sandbox.config.json" <<JSON
{ "root": "./sandbox", "host": "127.0.0.1", "port": $PORT, "adminToken": "admintok", "auth": "$MODE" }
JSON

  echo "== auth=$MODE (port $PORT) =="
  start_server "$MODE" "$PORT" "$T" || { stop_server; rm -rf "$T"; return; }

  local BASE="http://127.0.0.1:$PORT"
  local INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}'
  local H_JSON=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

  # 1. initialize without any Authorization header
  local CODE
  CODE=$(curl -s -m 5 -o "$T/init.json" -w '%{http_code}' -D "$T/init.hdr" -X POST "$BASE/mcp/default" "${H_JSON[@]}" -d "$INIT")
  case "$MODE" in
    none) check "POST /mcp/default without credentials" 200 "$CODE" ;;
    *)    check "POST /mcp/default without credentials" 401 "$CODE" ;;
  esac
  if [ "$MODE" != none ]; then
    grep -qi '^www-authenticate:.*oauth-protected-resource' "$T/init.hdr" \
      && printf '  ok   %-52s yes\n' "401 carries the RFC 6750 challenge" \
      || { printf '  FAIL %-52s\n' "401 carries the RFC 6750 challenge"; FAIL=1; }
  fi

  # 2. initialize with the project's own token
  local TOK; TOK=$(sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' "$T/data/projects.json" | head -1)
  [ -n "$TOK" ] || { printf '  FAIL %-52s\n' "read the seeded project token"; FAIL=1; }
  CODE=$(curl -s -m 5 -o "$T/init2.json" -w '%{http_code}' -D "$T/init2.hdr" -X POST "$BASE/mcp/default" \
    -H "Authorization: Bearer $TOK" "${H_JSON[@]}" -d "$INIT")
  check "POST /mcp/default with the project token" 200 "$CODE"

  # 3. a real tool call in that session (credentials only in the modes that need them)
  local SID; SID=$(grep -i '^mcp-session-id:' "$T/init2.hdr" | tr -d '\r' | awk '{print $2}')
  local AUTH_ARGS=()
  [ "$MODE" = none ] || AUTH_ARGS=(-H "Authorization: Bearer $TOK")
  CODE=$(curl -s -m 5 -o "$T/call.json" -w '%{http_code}' -X POST "$BASE/mcp/default" "${H_JSON[@]}" "${AUTH_ARGS[@]}" \
    -H "mcp-session-id: $SID" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fs_read","arguments":{"path":"hello.txt"}}}')
  check "tools/call fs_read in that session" 200 "$CODE"
  grep -q 'hello from sandbox' "$T/call.json" \
    && printf '  ok   %-52s yes\n' "fs_read streamed the real file contents" \
    || { printf '  FAIL %-52s\n' "fs_read streamed the real file contents"; FAIL=1; }

  # 4. OAuth surface
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/.well-known/oauth-authorization-server")
  case "$MODE" in any) check "GET /.well-known/oauth-authorization-server" 200 "$CODE" ;;
                 *)   check "GET /.well-known/oauth-authorization-server" 404 "$CODE" ;; esac
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/.well-known/oauth-protected-resource/mcp/default")
  case "$MODE" in any) check "GET /.well-known/oauth-protected-resource/mcp/default" 200 "$CODE" ;;
                 *)   check "GET /.well-known/oauth-protected-resource/mcp/default" 404 "$CODE" ;; esac
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$BASE/oauth/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' -d 'grant_type=authorization_code')
  case "$MODE" in any) check "POST /oauth/token" 401 "$CODE" ;;
                 *)   check "POST /oauth/token" 404 "$CODE" ;; esac

  # 5. the admin API is independent of --auth and reports the mode
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/api/projects")
  check "GET /api/projects without the admin token" 401 "$CODE"
  local WANT; [ "$MODE" = any ] && WANT=true || WANT=false
  check "GET /api/status" "{\"auth\":\"$MODE\",\"oauthEnabled\":$WANT}" \
    "$(curl -s -m 5 "$BASE/api/status" -H 'Authorization: Bearer admintok')"

  # 6. the banner must call out a wide-open endpoint
  if [ "$MODE" = none ]; then
    grep -q 'NO authentication' "$T/err.log" \
      && printf '  ok   %-52s yes\n' "startup banner warns about --auth none" \
      || { printf '  FAIL %-52s\n' "startup banner warns about --auth none"; FAIL=1; }
  fi

  stop_server
  rm -rf "$T"
}

run_mode none 8899
run_mode token 8900
run_mode any 8901

echo
[ "$FAIL" = 0 ] && echo "ALL E2E CHECKS PASSED" || echo "SOME E2E CHECKS FAILED"
exit $FAIL