#!/bin/bash
# compounds-hooks v5 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

echo '{"additionalContext": "Follow the returned tier path prompt through every step. For trivial-fallback (gen_spec returned trivial_path.md): create_project -> upload -> add_task -> direct edit -> implement_task_finalize. For standard: gen_master_spec -> validate_master_spec -> wc -c branch. Honor the flow style from plan_change for handoff and approval gates."}'
exit 0
