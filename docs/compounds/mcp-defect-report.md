# Compounds MCP Defect Report

**Date:** 2026-04-20
**Client:** Claude Code (Opus 4.7, 1M context)
**Server:** `compounds-dev` MCP
**Server health check:** healthy, connected to `https://api.dev.compounds.dev`
**Server version markers seen in errors:** Pydantic v2.12 (`errors.pydantic.dev/2.12/v/...`)

---

## Summary

Tool parameters typed as **list** or **dict** on the server side are received as **JSON-encoded strings** rather than parsed Python structures, causing Pydantic validation to reject every call with `input_type=str`.

Scalar-typed parameters (`str`, `bool`) work correctly. No workaround on the client side — the JSON arrives at the server unparsed.

---

## Affected Tools (confirmed)

| Tool | Failing Parameter | Declared Type |
|------|-------------------|---------------|
| `save_impact_report` | `impact_report` | dict |
| `pattern_detection` | `tech_stack`, `domains`, `components`, `change_types` | list[str] |
| `get_design_patterns` | `pattern_ids` | list[str] |

## Unaffected Tools (control set)

| Tool | Parameter | Type | Result |
|------|-----------|------|--------|
| `debug_echo` | `message` | str | OK |
| `health_check` | — | — | OK |
| `plan_change` | — | — | OK |
| `get_testing_frameworks` | `include_content` | bool | OK |
| `get_reference_architecture` | `ref_arch_id` | str | OK |
| `get_reference_architecture_context` | — | — | OK |

The split is perfectly aligned with parameter type: scalars pass, structured types fail.

---

## Reproduction

### Case 1 — `pattern_detection` minimal call

```
pattern_detection(tech_stack=["typescript"])
```

**Response:**
```
1 validation error for call[pattern_detection]
tech_stack
  Input should be a valid list [type=list_type, input_value='["typescript"]', input_type=str]
    For further information visit https://errors.pydantic.dev/2.12/v/list_type
```

### Case 2 — `save_impact_report` with empty dict

```
save_impact_report(workflow_id="test", impact_report={})
```

**Response:**
```
1 validation error for call[save_impact_report]
impact_report
  Input should be a valid dictionary [type=dict_type, input_value='{}', input_type=str]
    For further information visit https://errors.pydantic.dev/2.12/v/dict_type
```

### Case 3 — `get_design_patterns`

```
get_design_patterns(pattern_ids=["agents-error-handling"])
```

**Response:**
```
1 validation error for call[get_design_patterns]
pattern_ids
  Input should be a valid list [type=list_type, input_value='["agents-error-handling"]', input_type=str]
    For further information visit https://errors.pydantic.dev/2.12/v/list_type
```

---

## Diagnosis

The error messages show the exact payload the validator receives:

- `input_value='["typescript"]'` with `input_type=str`
- `input_value='{}'` with `input_type=str`

The value is a **JSON-formatted string**, not a parsed Python list/dict. This is consistent with one of:

1. **Server-side double-encoding bug** — the MCP handler receives the structured input correctly but re-serializes it to JSON once more before passing it to the Pydantic model, leaving a JSON string where a list/dict is expected.
2. **MCP adapter missing a `json.loads` step** — the tool call's `arguments` field is read as-is from the wire and handed to Pydantic without being parsed, so structured types come through as their JSON literal.
3. **Pydantic model declaration mismatch** — the field type annotation expects `list[str]` / `dict[...]`, but the FastMCP adapter is configured to pass-through raw JSON strings for those fields. Adding `Json[...]` wrappers or a `model_validator` would accept both formats.

The fact that `debug_echo(message=str)` and `get_testing_frameworks(include_content=bool)` succeed rules out a transport-level problem — scalars arrive correctly. Only structured types are affected.

A separate but related symptom: `debug_whoami` fails with `cannot import name 'get_user_context' from 'auth.context' (/app/apps/mcp/src/auth/context.py)`. That is a Python import error at load time, unrelated to the serialization bug but worth knowing about.

---

## Impact

The Compounds workflow cannot be completed from Claude Code. `plan_change` explicitly directs the agent to call `save_impact_report` → `pattern_detection` → `get_design_patterns` before routing to `gen_spec`. All three of these tools reject their primary parameter, so the workflow dead-ends before any tier is assigned.

Since the workflow is documented as the **mandatory entry point for every code change**, and `get_design_patterns` is documented as **required** after pattern detection, there is no sanctioned path forward for the agent when these tools are broken.

---

## Suggested Fix

On the MCP server handler that wraps these Pydantic models, add an input-parsing step to handle JSON-encoded structured types:

```python
# pseudo-Python
def _coerce_structured(raw):
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    return raw
```

Apply to `impact_report`, `tech_stack`, `domains`, `components`, `change_types`, `pattern_ids` before Pydantic validation. Alternatively, annotate those fields with Pydantic's `Json` wrapper, which performs the coercion automatically.

---

## Workaround Used

The `plan_change` prompt notes that `save_impact_report` returns a `write_instruction` telling the agent where to persist the JSON anyway. I wrote `.compounds/workflows/{workflow_id}/impact_report.json` by hand and continued the workflow there — but `pattern_detection` and `get_design_patterns` have no equivalent filesystem fallback, so the workflow still dead-ends.

---

## Environment

- macOS Darwin 25.4.0
- Claude Code CLI running `CLAUDECODE=1`
- Compounds CLI: `0.11.4rc33`
- `compounds status` reports repo `github.com/jeffgabriel/eurorails_ai` indexed at v5, "Graph and vector stores consistent"
- `compounds health_check` reports healthy MCP connected to `https://api.dev.compounds.dev`
