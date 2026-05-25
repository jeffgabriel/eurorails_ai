#!/bin/bash
# compounds-hooks v5 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

echo '{"additionalContext": "Tasks are generating asynchronously (~30s). Poll get_project_status(project_id) every ~60s until breakdown_status=COMPLETED, then call implement_all_tasks(project_id). Do NOT stop or present a handoff — the user already approved this session at the standard handoff gate, or you are in hands_free/planning_gate mode and continue inline."}'
exit 0
