#!/bin/bash
# compounds-hooks v5 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

echo '{"additionalContext": "Save the master spec to .compounds/workflows/{workflow_id}/master-spec.md, then call validate_master_spec(workflow_id, scenario_type, included_sections, flow_style). Pass scenario_type and included_sections from the context field of the gen_master_spec response — they are required, not optional."}'
exit 0
