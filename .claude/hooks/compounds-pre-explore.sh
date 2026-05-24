#!/bin/bash
# compounds-hooks v3 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

# Gate Glob/Grep/Agent until the agent has called plan_change() or compounds search.
# Read is always allowed — reading a specific known file is fine.
#
# Unlocks when compounds_searched OR plan_change_called marker exists.
#
# Fail-open (ADR-3): any error exits 0 with advisory context.

INPUT=$(cat)

# Extract the tool name from the hook input
TOOL_NAME=""
if command -v jq >/dev/null 2>&1; then
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
fi

# Always allow Read — reading a specific known file is fine
if [ "$TOOL_NAME" = "Read" ]; then
    # Context-aware advisory: stronger message when change_intent exists and no unlock marker
    COMPOUNDS_DIR=".compounds/workflows"
    UNLOCKED=$(find "$COMPOUNDS_DIR" \( -name "compounds_searched" -o -name "plan_change_called" \) -print -quit 2>/dev/null)
    CHANGE_INTENT=$(find "$COMPOUNDS_DIR/_session" -name "change_intent" -print -quit 2>/dev/null)
    if [ -z "$UNLOCKED" ] && [ -n "$CHANGE_INTENT" ]; then
        echo '{"additionalContext": "STOP. You appear to be planning a code change. Call plan_change() via Compounds MCP FIRST — it explores the codebase for you. Do NOT use Read/Glob/Grep/Agent/Bash-grep to explore source files for planning."}'
    else
        echo '{"additionalContext": "For broader codebase exploration, prefer using plan_change() or compounds search via Compounds MCP."}'
    fi
    exit 0
fi

# Always allow Agent — subagents are model-internal delegation used for
# web research, parallel tasks, implementation, etc. Blocking them causes
# false positives. CLAUDE.md rules guide agents to call plan_change() first.
if [ "$TOOL_NAME" = "Agent" ]; then
    echo '{"additionalContext": "For codebase exploration, prefer plan_change() or compounds search via Compounds MCP."}'
    exit 0
fi

COMPOUNDS_DIR=".compounds/workflows"

# If .compounds/workflows doesn't exist, block with specific message
if [ ! -d "$COMPOUNDS_DIR" ]; then
    echo '{"decision": "block", "reason": "Run plan_change() (or `compounds search`) first — it initializes workflow state and loads codebase context. After that, Glob/Grep/Agent/Read work normally."}'
    exit 0
fi

# Check for unlock markers: compounds_searched (written by compounds search) OR
# plan_change_called (written by PostToolUse after plan_change() MCP call)
UNLOCKED=$(find "$COMPOUNDS_DIR" \( -name "compounds_searched" -o -name "plan_change_called" \) -print -quit 2>/dev/null)

if [ -n "$UNLOCKED" ]; then
    # Compounds workflow entry point was used — allow exploration
    echo '{"additionalContext": "Compounds workflow entry called. You may read specific files identified by search results."}'
    exit 0
fi

# No unlock marker — block Glob/Grep/Agent and direct to plan_change()
echo '{"decision": "block", "reason": "Call plan_change() via Compounds MCP first — it loads codebase context that makes exploration more effective. Exploration tools (Glob/Grep/Agent/Read/Bash-grep) work normally after plan_change() runs."}'
exit 0
