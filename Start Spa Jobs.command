#!/bin/bash
# Double-click this file to start Spa Jobs.
# First time: right-click it, choose Open, then Open again.
cd "$(dirname "$0")"

# If it's already running, just open the browser.
if curl -s -o /dev/null http://localhost:4321/api/meta; then
  echo "Spa Jobs is already running."
  open http://localhost:4321
  exit 0
fi

echo "Starting Spa Jobs..."
echo ""
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
if [ -n "$IP" ]; then
  echo "  On this computer:  http://localhost:4321"
  echo "  On your phone (same wifi):  http://$IP:4321"
  echo ""
fi
echo "Leave this window open while you use the system."
echo "To stop: close this window (or press Ctrl+C)."
echo ""

( sleep 2 && open http://localhost:4321 ) &
exec ./runtime/bin/node server.js
