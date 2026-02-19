#!/bin/bash
set -e

OLLAMA_MODEL="${OLLAMA_MODEL:-llama-guard3:1b}"

echo "[Ollama] Starting Ollama server..."
ollama serve &
SERVER_PID=$!

echo "[Ollama] Waiting for server to be ready..."
MAX_WAIT=120
ELAPSED=0
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; do
  if [ $ELAPSED -ge $MAX_WAIT ]; then
    echo "[Ollama] ERROR: Server failed to start within ${MAX_WAIT}s"
    exit 1
  fi
  echo "[Ollama] Not ready yet... (${ELAPSED}s elapsed)"
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done
echo "[Ollama] Server is ready (took ${ELAPSED}s)"

if ollama list | grep -q "$OLLAMA_MODEL"; then
  echo "[Ollama] Model '$OLLAMA_MODEL' already cached"
else
  echo "[Ollama] Pulling model '$OLLAMA_MODEL'..."
  ollama pull "$OLLAMA_MODEL"
  echo "[Ollama] Model '$OLLAMA_MODEL' pulled successfully"
fi

echo "[Ollama] Ready to serve requests"
wait $SERVER_PID
