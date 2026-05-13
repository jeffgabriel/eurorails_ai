#!/bin/bash
# compounds-hooks v3 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

# Record that plan_change() was called so the pre-explore hook can allow
# subsequent Read/Glob/Grep/Agent calls in this session.
#
# Tries multiple JSON paths for workflow_id since Claude Code may structure
# the PostToolUse hook input differently across versions.
#
# Fail-open (ADR-3): if jq is unavailable or workflow_id not found,
# we write a fallback marker and still emit advisory context.

INPUT=$(cat)

WORKFLOW_ID=""
if command -v jq >/dev/null 2>&1; then
    # Try multiple paths — Claude Code PostToolUse input structure may vary
    WORKFLOW_ID=$(echo "$INPUT" | jq -r '
        .tool_response.workflow_id //
        .response.workflow_id //
        .workflow_id //
        ""' 2>/dev/null)
fi

if [ -n "$WORKFLOW_ID" ]; then
    MARKER_DIR=".compounds/workflows/${WORKFLOW_ID}"
    mkdir -p "$MARKER_DIR" 2>/dev/null || true
    touch "${MARKER_DIR}/plan_change_called" 2>/dev/null || true
else
    # Fallback: write marker to a session-generic dir so blocking still unlocks
    FALLBACK_DIR=".compounds/workflows/_fallback"
    mkdir -p "$FALLBACK_DIR" 2>/dev/null || true
    touch "${FALLBACK_DIR}/plan_change_called" 2>/dev/null || true
fi

echo '{"additionalContext": "Follow the returned prompt through all steps. Do not skip steps or implement directly."}'
exit 0
