#!/usr/bin/env bash
#
# Aurora Pulse · Startup-Messung
#
# Misst den Cold-Start eines Aurora-Pulse-Builds anhand der
# `STARTUP_MARK` / `STARTUP_MARK_RENDERER`-Marker, die App und Renderer
# während des Hochfahrens in `~/Library/Application\ Support/Aurora_Pulse/Logs/`
# loggen. Das Skript:
#
#   1. merkt sich, wo `main.log` und `renderer.log` aktuell stehen
#   2. startet den übergebenen `AuroraPulse.app`-Pfad
#   3. wartet `--wait`-Sekunden (default 25), damit der Sync auch bei
#      großen Libraries komplett durchläuft
#   4. beendet die App sauber
#   5. dumpt den Tail der neu hinzugekommenen Marker
#   6. extrahiert vier Schlüsselwerte:
#        • main_window_show         → erster sichtbarer Pixel
#        • main_window_load_file_resolved
#        • register_auto_updater_deferred
#        • Sync-Dauer (sync_started_at / sync_finished_at aus media_providers.db)
#
# Beispiel:
#   ./scripts/perf/measure-startup.sh /Applications/AuroraPulse.app vorher
#   ./scripts/perf/measure-startup.sh ./release/mac-arm64/AuroraPulse.app nachher
#
set -euo pipefail

APP_PATH="${1:-}"
LABEL="${2:-run}"
WAIT_SECONDS="${WAIT_SECONDS:-25}"
LOG_DIR="$HOME/Library/Application Support/Aurora_Pulse/Logs"
MAIN_LOG="$LOG_DIR/main.log"
RENDERER_LOG="$LOG_DIR/renderer.log"
DB_PATH="$HOME/Library/Application Support/Aurora_Pulse/Databases/media_providers.db"
REPORT_DIR="${REPORT_DIR:-/tmp}"

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "Usage: $0 <path/to/AuroraPulse.app> [label]"
  echo "       Optional WAIT_SECONDS env var (default 25)"
  exit 64
fi

if [ ! -f "$MAIN_LOG" ]; then
  echo "main.log not found at $MAIN_LOG"
  echo "→ App muss mindestens einmal manuell gestartet worden sein, damit"
  echo "  electron-log das Logfile angelegt hat."
  exit 65
fi

# Bestehende Aurora-Instanz killen, sonst misst Marker nichts.
pkill -f "AuroraPulse" 2>/dev/null || true
sleep 1

MAIN_BEFORE=$(wc -l < "$MAIN_LOG" || echo 0)
RENDERER_BEFORE=$(wc -l < "$RENDERER_LOG" || echo 0)

echo "================================================================"
echo "Aurora Pulse Startup-Measurement"
echo "  Build: $APP_PATH"
echo "  Label: $LABEL"
echo "  Wait : ${WAIT_SECONDS}s"
echo "================================================================"

T0=$(date +%s.%N)
open -a "$APP_PATH"
echo "[t=0s ] launched"

sleep "$WAIT_SECONDS"
T1=$(date +%s.%N)
ELAPSED=$(python3 -c "print(f'{($T1)-($T0):.1f}')")
echo "[t=${ELAPSED}s] sending quit"

osascript -e 'tell application "AuroraPulse" to quit' 2>/dev/null || true
sleep 2
pkill -f "AuroraPulse" 2>/dev/null || true
sleep 1

REPORT_FILE="$REPORT_DIR/aurora-startup-$LABEL.txt"
{
  echo "=== Aurora Pulse · Startup Report ($LABEL) ==="
  echo "App   : $APP_PATH"
  echo "Time  : $(date '+%Y-%m-%d %H:%M:%S')"
  echo
  echo "--- main.log new STARTUP_MARK lines ---"
  tail -n +"$((MAIN_BEFORE+1))" "$MAIN_LOG" | grep "STARTUP_MARK" || echo "(none)"
  echo
  echo "--- renderer.log new STARTUP_MARK_RENDERER lines ---"
  tail -n +"$((RENDERER_BEFORE+1))" "$RENDERER_LOG" | grep "STARTUP_MARK_RENDERER" || echo "(none)"
  echo
  echo "--- media_providers.db sync timestamps (last 3 entries) ---"
  if [ -f "$DB_PATH" ]; then
    python3 - "$DB_PATH" <<'PY'
import json, sys
path = sys.argv[1]
runs = []
with open(path, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("identifier") != "media_local":
            continue
        s = obj.get("sync_started_at")
        f = obj.get("sync_finished_at")
        if s and f:
            runs.append((s, f, f - s))
for s, f, d in runs[-3:]:
    import datetime
    print(f"  {datetime.datetime.fromtimestamp(s/1000).strftime('%Y-%m-%d %H:%M:%S')} → {d/1000:.2f}s ({d}ms)")
if not runs:
    print("  (no sync runs persisted yet)")
PY
  else
    echo "  (database not found at $DB_PATH)"
  fi
} | tee "$REPORT_FILE"

echo
echo "→ Report saved to: $REPORT_FILE"