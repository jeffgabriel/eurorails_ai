#!/bin/bash
# compounds-hooks v5 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

# Plain text stdout is added visibly to the model's transcript.

AUTH_MSG=""
COMPOUNDS_HOME="$HOME/.compounds"
if [ ! -d "$COMPOUNDS_HOME" ] || ! ls "$COMPOUNDS_HOME"/oauth_tokens_*.enc >/dev/null 2>&1; then
    AUTH_MSG="WARNING: Compounds CLI may not be authenticated. Run 'compounds auth login' before starting work."
fi

# Auto-update CLI if a newer version is available (non-blocking)
if command -v compounds >/dev/null 2>&1; then
    compounds update 2>/dev/null || true
fi

cat <<'EOF'
========== COMPOUNDS WORKFLOW RULES ==========
This repo uses Compounds MCP tools. You MUST use them:

1. For ANY code change: call plan_change() FIRST via Compounds MCP.
   plan_change() explores the codebase for you — do NOT use Read/Glob/Grep
   to explore source files yourself for planning purposes.

2. Follow the FULL workflow for the tier — never skip steps:

   TRIVIAL (preferred): plan_change(start) → plan_change(start_trivial) →
                        [direct edit + git commit] → create_project(status="DONE")

   TRIVIAL (fallback):  plan_change → … → gen_spec(tier="trivial") →
                        create_project → upload → add_task → [direct edit] →
                        implement_task_finalize
                        (NO implement_task, NO implement_all_tasks)

   STANDARD:            plan_change(start) → plan_change(start_standard) →
                        locate/impact/classify/route → gen_spec(tier="standard") →
                        gen_master_spec → validate_master_spec →
                        wc -c master-spec.md →
                        Branch A (≤ MAX_SPEC_CHARS_STANDARD):
                          create_project → upload
                        Branch B (> MAX_SPEC_CHARS_STANDARD):
                          gen_project_spec ×2 → validate_project_specs →
                          create_project ×2 → upload ×2
                        → HANDOFF (per flow style: STOP or auto-proceed)
                        → [implementation session]
                          generate_tasks → implement_all_tasks →
                          implement_task → implement_task_finalize

   HANDOFF (Standard, used in guided/implementation_gate flow styles):
     "Compounds, create tasks and then implement project <title>: <id>"

3. HANDOFF RULE: Follow the flow style from plan_change for handoff gates.
   Flow styles control where the workflow stops:
   - hands_free: No gates — skips spec review AND implementation handoff, auto-implements
   - planning_gate: Gates at spec review only, then auto-proceeds through implementation
   - implementation_gate: Skips spec review, gates at implementation handoff (standard)
   - guided (default): Gates at spec review, implementation handoff, and implementation approval

4. implement_all_tasks is the implementation entry point. After each
   implement_task_finalize, call implement_all_tasks again to sync
   progress and get the next task.

5. Use get_project_status() / get_project_tasks() to check existing work.

6. If Compounds MCP server is not connected or returns auth errors,
   STOP and tell the user to run: compounds auth login (or check /mcp).

7. For pure questions that don't require reading code (e.g., "how do I
   authenticate?"), you may proceed without Compounds. This exemption does
   NOT apply to requests that say "plan", "change", "fix", "build", "add",
   "improve", or "review the code" — those require plan_change() first.
===================================================
EOF

if [ -n "$AUTH_MSG" ]; then
    echo "$AUTH_MSG"
fi

# Clean up stale session markers from previous sessions
rm -f .compounds/workflows/_session/change_intent 2>/dev/null || true
rm -f .compounds/workflows/_session/compounds_searched 2>/dev/null || true
rm -f .compounds/workflows/_fallback/plan_change_called 2>/dev/null || true

# Inject CLI usage reference so the agent has it from session start
if command -v compounds >/dev/null 2>&1; then
    echo ""
    echo "========== COMPOUNDS CLI REFERENCE =========="
    echo "Use these commands (via Bash) to explore the codebase — do NOT use Read/Glob/Grep directly."
    echo ""
    compounds agent-prompt cli-usage 2>/dev/null || true
    echo "=============================================="
fi

exit 0
