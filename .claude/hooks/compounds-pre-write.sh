#!/bin/bash
# compounds-hooks v3 — installed by 'compounds init-hooks'
# Do not edit manually — re-run 'compounds init-hooks' to update

echo '{"additionalContext": "Are you inside an implement_task() workflow? Do not edit source files directly outside of Compounds implementation. If writing E2E tests, remember you MUST also run them before finalizing — writing tests is not the same as passing tests."}'
exit 0
