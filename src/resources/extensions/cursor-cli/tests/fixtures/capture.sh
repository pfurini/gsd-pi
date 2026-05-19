#!/usr/bin/env bash
# Capture a live cursor-agent NDJSON run and produce a committable fixture.
#
# Usage:
#   ./capture.sh <fixture-name> <prompt-file> [<model>]
#
# Example:
#   ./capture.sh 01-hello-text prompts/01-hello.txt
#   ./capture.sh 02-single-tool-call prompts/02-read-fixture.txt composer-2
#
# Outputs (relative to this directory):
#   raw/<fixture-name>.ndjson        # gitignored, untouched capture
#   <fixture-name>.ndjson            # sanitised, committed
#   <fixture-name>.meta.json         # version, model, sanitised-at
#
# A tiny helper workspace is built under a `mktemp -d` so the agent has a
# deterministic CWD whose contents we control (e.g. small fixture files
# that drive tool-call prompts).

set -euo pipefail

if [ "$#" -lt 2 ]; then
	echo "usage: $0 <fixture-name> <prompt-file> [<model>]" >&2
	exit 64
fi

FIXTURE_NAME="$1"
PROMPT_FILE="$2"
MODEL="${3:-composer-2}"

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if [ ! -f "$PROMPT_FILE" ]; then
	echo "prompt file not found: $PROMPT_FILE" >&2
	exit 66
fi

if ! command -v cursor-agent >/dev/null 2>&1; then
	echo "cursor-agent not on PATH" >&2
	exit 69
fi

mkdir -p raw

WORKSPACE="$(mktemp -d "${TMPDIR:-/tmp}/cursor-fixture.XXXXXX")"
cleanup() {
	rm -rf "$WORKSPACE"
}
trap cleanup EXIT

# Seed helper files some prompts expect to find in the workspace.
case "$FIXTURE_NAME" in
	02-*)
		printf 'fixture-hello\n' > "$WORKSPACE/hello.txt"
		;;
	03-*)
		printf 'alpha\n' > "$WORKSPACE/a.txt"
		printf 'bravo\n' > "$WORKSPACE/b.txt"
		printf 'charlie\n' > "$WORKSPACE/c.txt"
		;;
esac

PROMPT_TEXT="$(cat "$PROMPT_FILE")"
RAW_PATH="raw/${FIXTURE_NAME}.ndjson"
SANITISED_PATH="${FIXTURE_NAME}.ndjson"
META_PATH="${FIXTURE_NAME}.meta.json"

CURSOR_VERSION="$(cursor-agent --version 2>/dev/null | head -1)"

echo "[capture] cursor-agent ${CURSOR_VERSION}, model=${MODEL}" >&2
echo "[capture] workspace=${WORKSPACE}" >&2
echo "[capture] writing raw=${RAW_PATH}" >&2

cursor-agent \
	-p \
	--output-format stream-json \
	--stream-partial-output \
	--workspace "$WORKSPACE" \
	--trust \
	--force \
	--sandbox enabled \
	--model "$MODEL" \
	"$PROMPT_TEXT" \
	> "$RAW_PATH"

RAW_BYTES="$(wc -c < "$RAW_PATH" | tr -d ' ')"
RAW_LINES="$(wc -l < "$RAW_PATH" | tr -d ' ')"

node "$HERE/sanitize.mjs" "$RAW_PATH" > "$SANITISED_PATH"

SAN_BYTES="$(wc -c < "$SANITISED_PATH" | tr -d ' ')"
SAN_LINES="$(wc -l < "$SANITISED_PATH" | tr -d ' ')"

SANITISED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

cat > "$META_PATH" <<EOF
{
  "fixture": "${FIXTURE_NAME}",
  "cursor_agent_version": "${CURSOR_VERSION}",
  "model": "${MODEL}",
  "prompt_file": "${PROMPT_FILE}",
  "sanitised_at": "${SANITISED_AT}",
  "raw_bytes": ${RAW_BYTES},
  "raw_lines": ${RAW_LINES},
  "sanitised_bytes": ${SAN_BYTES},
  "sanitised_lines": ${SAN_LINES}
}
EOF

echo "[capture] sanitised=${SANITISED_PATH} (${SAN_BYTES}B, ${SAN_LINES} lines)" >&2
echo "[capture] meta=${META_PATH}" >&2
echo "[capture] DONE" >&2
