#!/usr/bin/env bash
# Stop test opencode servers by port without pkill-ing the caller's own shell
# (the caller's command line often contains the same pattern). Usage:
#   bash test/stop_servers.sh <port> [port...]
for port in "$@"; do
  pkill -f "opencode serve --port $port" 2>/dev/null
done
exit 0
