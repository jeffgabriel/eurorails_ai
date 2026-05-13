#!/bin/bash
# compounds-hooks v3 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

INPUT=$(cat)
ACTION=$(echo "$INPUT" | jq -r '.tool_response.action // ""')

if [ "$ACTION" = "prioritize" ]; then
    echo '{"additionalContext": "Analyze task dependencies and determine priority order. Call implement_all_tasks again with task_order=[...] to save the order and begin implementation."}'
elif [ "$ACTION" = "all_tasks_complete" ]; then
    echo '{"additionalContext": "All tasks are complete. Auto-proceed mode is OVER. Display the returned prompt to the user exactly as-is and STOP. Do NOT generate your own summary."}'
elif [ "$ACTION" = "order_saved" ]; then
    echo '{"additionalContext": "You are now in auto-proceed mode. Do NOT stop between tasks. Do NOT ask the user should I continue or present commit summaries for approval. Execute git commands directly. Implement continuously — the ONLY time you stop is when all_tasks_complete is returned."}'
else
    echo '{"additionalContext": "After each implement_task_finalize, call implement_all_tasks again to sync progress and get the next task redirect."}'
fi
exit 0
