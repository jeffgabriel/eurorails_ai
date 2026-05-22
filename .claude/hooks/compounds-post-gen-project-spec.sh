#!/bin/bash
# compounds-hooks v5 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

echo '{"additionalContext": "Save the per-project spec to .compounds/workflows/{workflow_id}/pending/spec-{N}-{slug}.md and run `wc -c` as the size guard. After ALL per-project specs are saved, call validate_project_specs(workflow_id, flow_style) ONCE — not per-spec."}'
exit 0
