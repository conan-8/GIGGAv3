#!/usr/bin/env bash
# Stop test servers by port without pkill-ing the caller's own shell (the
# caller's command line often contains the same pattern). Kills both the
# opencode server and any GIGGA dashboard node server on that port.
#   bash test/stop_servers.sh <port> [port...]
for port in "$@"; do
  pkill -f "opencode serve --port $port" 2>/dev/null
  pkill -f "dashboard/server.mjs --port $port" 2>/dev/null
  pkill -f "server.mjs --port $port" 2>/dev/null
done
exit 0
