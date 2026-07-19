#!/bin/bash
# Kill the WHOLE vite process tree on exit. The earlier `kill $VITE_PID`
# only reaped the npx wrapper, leaving the real vite server (~800 MB)
# orphaned; four of those starved the box to 1.5 GB free and the
# environment reaped every long suite run.
cleanup() {
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { \$_.CommandLine -match 'TreasureHunter|vite --port' } | ForEach-Object { try { Stop-Process -Id \$_.ProcessId -Force -EA Stop } catch {} }" 2>/dev/null
}
trap cleanup EXIT INT TERM
npx vite --port 5173 > scratchpad/vite-wp5.log 2>&1 &
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/ || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "dev server up (http $code) at $(date +%H:%M:%S)"
node scratchpad/wp5-accept.mjs
echo "=== wp5 EXIT $? at $(date +%H:%M:%S) ==="
