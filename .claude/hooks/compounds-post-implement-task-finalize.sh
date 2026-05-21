#!/bin/bash
# compounds-hooks v3 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

echo '{"additionalContext": "Ensure all required tests passed. If the task involved UI changes, E2E tests and visual verification must have been run. Follow the validation prompt if phase=validate. After finalizing, call implement_all_tasks() again to sync progress and get the next task."}'
exit 0
