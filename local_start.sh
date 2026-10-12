#!/usr/bin/env bash
# Usage: ./local_start.sh start|stop|restart|reset|status|logs [--port 9123] [--data-dir PATH]
set -euo pipefail
TASK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$TASK_ROOT/scripts/local_web.py" "$@"
