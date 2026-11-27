#!/usr/bin/env bash
# Daming remote check-in control (runs ON the Linux host).
# start  -> detached (setsid nohup), survives SSH/main-host shutdown
# stop   -> only explicit stop kills it
# status -> running pid / stopped
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$DIR/daemon.pid"
LOG="$DIR/daemon.log"
NODE="${DAMING_NODE:-node}"

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

start() {
  if is_running; then echo "already running pid $(cat "$PIDFILE")"; return 0; fi
  setsid nohup "$NODE" "$DIR/checkin-daemon.mjs" >>"$LOG" 2>&1 </dev/null &
  echo $! > "$PIDFILE"
  sleep 0.3
  if is_running; then echo "started pid $(cat "$PIDFILE")"; else echo "start failed (see $LOG)"; rm -f "$PIDFILE"; return 1; fi
}
stop() {
  if is_running; then
    local pid; pid="$(cat "$PIDFILE")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do is_running || break; sleep 0.1; done
    is_running && { kill -9 "$pid" 2>/dev/null || true; sleep 0.1; }
    rm -f "$PIDFILE"; echo "stopped"
  else echo "not running"; rm -f "$PIDFILE"; fi
}
status() { if is_running; then echo "running pid $(cat "$PIDFILE")"; else echo "stopped"; fi }

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  once) "$NODE" "$DIR/checkin-daemon.mjs" --once ;;
  *) echo "usage: $0 start|stop|status|once"; exit 2 ;;
esac
