#!/bin/bash
# compounds-hooks v5 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

echo '{"additionalContext": "After validation passes, run `wc -c` on .compounds/workflows/{workflow_id}/master-spec.md. If it exceeds MAX_SPEC_CHARS_STANDARD, follow Branch B (gen_project_spec ×2 → validate_project_specs). Otherwise follow Branch A (create_project → upload). Then present the spec for review per flow style."}'
exit 0
