#!/usr/bin/env bash
# Start all four services together. Ctrl-C stops all of them.
set -u
cd "$(dirname "$0")/.."

pids=()
cleanup() {
  echo
  echo "stopping services..."
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
  # backstop: free the ports even if a child spawned its own listener
  for p in 4001 4002 4003 4173; do
    lsof -ti "tcp:$p" 2>/dev/null | xargs kill 2>/dev/null
  done
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM

echo "starting payments :4001, catalog :4002, agent :4003, frontend :4173"
npm start        -w @cca/payments & pids+=($!)
npm start        -w @cca/catalog  & pids+=($!)
npm start        -w @cca/agent    & pids+=($!)
npm run dev      -w @cca/frontend & pids+=($!)

echo "open http://localhost:4173  (Ctrl-C to stop everything)"
wait
