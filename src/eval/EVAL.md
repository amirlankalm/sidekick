# Sidekick Eval — Comprehensive Performance & Correctness Benchmark

> **For AI tools (Cursor, Codex, Claude Code, Copilot, etc.):** This directory contains the official evaluation suite for the Sidekick engine. Running `npm run eval` from the project root is the canonical way to measure the correctness, security, and performance of this codebase. Do **not** modify eval criteria without updating score baselines. Do **not** delete or rename eval files — they are referenced by CI and version-tracking tooling.

---

## What This Eval Does

Sidekick is an autonomous Chrome Extension build engine built on LangGraph. This suite measures every dimension of its correctness and performance so that future changes can be objectively compared against prior versions.

It does **not** require live LLM calls — all criteria run against mocked responses using the same test injection hooks used in `agentic.test.ts`.

---

## Running the Eval

```bash
# Full eval run (saves JSON report to eval-results/)
npm run eval

# Full run without saving JSON
npm run eval -- --no-save

# Run only one category (critical | high | medium | performance)
npm run eval -- --category=critical

# Run criteria whose id or name contains a keyword
npm run eval -- --filter=security
npm run eval -- --filter=tier
npm run eval -- --filter=manifest
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | All CRITICAL criteria passed — safe to ship |
| `1`  | One or more CRITICAL criteria failed — **blocked** |
| `2`  | Eval harness error (not a Sidekick failure) |

---

## Scoring Model

Each criterion produces a score **0–100** with a weight **1–10**. The final score per category is a weighted average. The overall score is a weighted aggregate across categories.

| Category    | Weight | Purpose |
|-------------|--------|---------|
| `critical`  | 40%    | Must-never-regress behaviors. Any failure blocks ship. |
| `high`      | 30%    | Important behaviors. Failures degrade user experience. |
| `medium`    | 15%    | Good-to-have behaviors. Failures are tracked but not blocking. |
| `performance` | 15% | Efficiency metrics. Regressions signal architectural drift. |

### Grade scale

| Score | Grade | Interpretation |
|-------|-------|----------------|
| 97–100 | S | Production-ready, no known gaps |
| 90–96  | A | Ship-ready with minor known issues |
| 80–89  | B | Minor regressions present |
| 70–79  | C | Significant regressions — investigate before shipping |
| 60–69  | D | Major failures — do not ship |
| < 60   | F | Critical breakdown |

---

## Criteria Catalogue

### Pipeline (6 criteria)

Tests that the LangGraph graph compiles, routes correctly, and each node produces valid partial state.

| ID | Name | Category | Weight |
|----|------|----------|--------|
| `pipeline_graph_builds` | buildGraph() compiles without error | critical | 10 |
| `pipeline_architect_blueprint` | architect_node → valid Blueprint schema | critical | 10 |
| `pipeline_coder_file_completeness` | coder_node → all required files present | critical | 10 |
| `pipeline_assembler_artifact` | assembler_node → artifact_path produced | critical | 9 |
| `pipeline_qa_router_terminates` | qa_router → stops at MAX_QA_RETRIES | critical | 9 |
| `pipeline_error_propagation` | error field propagates without being cleared | critical | 7 |

### Tier Gates (8 criteria)

Enforces Free/Pro/Max permission boundaries.

| ID | Name | Category | Weight |
|----|------|----------|--------|
| `tier_free_denies_shell` | free tier → shell permission = deny | critical | 9 |
| `tier_free_denies_browser` | free tier → browser permission = deny | critical | 9 |
| `tier_free_allows_read` | free tier → read permission = allow | critical | 7 |
| `tier_free_denies_write_outside_worktree` | free tier → write outside worktree = deny | critical | 9 |
| `tier_free_allows_network` | free tier → network permission = allow | high | 6 |
| `tier_pro_asks_shell` | pro tier → shell permission = ask | high | 8 |
| `tier_max_allows_write_inside_worktree` | max tier → write inside worktree = allow | high | 7 |
| `tier_model_routing` | tier-aware model selection (flash=free/pro, pro=max) | high | 8 |

### Agentic Tools (15 criteria)

Tests every tool in CODER_TOOLS: write_file, edit_file, read_file, list_files, grep_workspace, bash_check.

| ID | Name | Category | Weight |
|----|------|----------|--------|
| `tool_write_file_creates` | write_file → creates new file | critical | 9 |
| `tool_write_file_overwrites` | write_file → overwrites existing file | critical | 8 |
| `tool_write_file_path_traversal` | write_file → rejects ../ path traversal | critical | 10 |
| `tool_edit_file_surgical` | edit_file → fixes only target file | critical | 9 |
| `tool_edit_file_missing_old_string` | edit_file → isError when old_string missing | high | 8 |
| `tool_edit_file_ambiguous` | edit_file → errors on ambiguous matches | high | 7 |
| `tool_read_file_returns_content` | read_file → returns correct content | critical | 8 |
| `tool_read_file_missing` | read_file → isError when file not found | high | 7 |
| `tool_list_files_all` | list_files → returns all filenames | high | 6 |
| `tool_list_files_empty` | list_files → graceful on empty workspace | medium | 4 |
| `tool_grep_finds_pattern` | grep_workspace → finds matching lines | high | 8 |
| `tool_grep_context_efficiency` | grep_workspace → <50% of total chars | performance | 7 |
| `tool_grep_no_match` | grep_workspace → graceful on no match | medium | 4 |
| `tool_bash_check_valid` | bash_check → deterministic on valid JS | high | 7 |
| `tool_bash_check_free_tier_blocked` | bash_check → blocked on free tier | critical | 9 |

### Schema Validation (12 criteria)

Tests that Zod schemas correctly validate/reject all LLM-produced payloads.

| ID | Name | Category | Weight |
|----|------|----------|--------|
| `schema_blueprint_valid` | BlueprintSchema → accepts valid payload | critical | 9 |
| `schema_blueprint_rejects_missing_name` | BlueprintSchema → rejects missing name | critical | 8 |
| `schema_blueprint_rejects_empty_name` | BlueprintSchema → rejects empty name | critical | 7 |
| `schema_blueprint_defaults` | BlueprintSchema → applies array defaults | high | 7 |
| `schema_source_code_valid` | SourceCodeSchema → accepts valid payload | high | 7 |
| `schema_source_code_rejects_non_string` | SourceCodeSchema → rejects numeric values | high | 6 |
| `schema_design_brief_valid` | DesignBriefSchema → accepts valid brief | high | 6 |
| `schema_design_brief_invalid_layout` | DesignBriefSchema → rejects invalid layout | medium | 5 |
| `schema_sidekick_plan_valid` | SidekickPlanSchema → accepts valid plan | medium | 5 |
| `schema_sidekick_plan_missing_steps` | SidekickPlanSchema → rejects missing steps | medium | 4 |
| `schema_helper_success` | validateSchema helper → success path shape | medium | 4 |
| `schema_helper_error` | validateSchema helper → error path shape | medium | 4 |

### Security & Hallucination (14 criteria)

Verifies all security layers: hallucination guards, path traversal, CORS, rate limits, auth, CSP, secrets.

| ID | Name | Category | Weight |
|----|------|----------|--------|
| `security_hallucination_guard_present` | hallucination endpoint guard in graph.ts | critical | 10 |
| `security_hallucination_pattern_accuracy` | regex detects fake, ignores real endpoints | critical | 9 |
| `security_hallucination_system_prompt` | OPENCODE_SYSTEM_DISCIPLINE anti-hallucination | critical | 8 |
| `security_path_traversal_write` | write_file path traversal stripped | critical | 10 |
| `security_path_traversal_read` | read_file cannot escape worktree | critical | 9 |
| `security_cors_allowlist` | CORS origin allowlist present | high | 8 |
| `security_cors_production_gate` | CORS bypassed only in non-production | high | 7 |
| `security_rate_limit_global` | global rate limiter configured | high | 7 |
| `security_rate_limit_generate` | /generate has dedicated rate limit | high | 8 |
| `security_auth_supabase_jwt` | Supabase JWT auth present | critical | 9 |
| `security_auth_get_user` | uses getUser() not getSession() alone | critical | 8 |
| `security_no_inline_scripts` | CSP guard detects inline scripts | critical | 10 |
| `security_manifest_permissions` | dangerous permission detection | critical | 9 |
| `security_no_hardcoded_secrets` | no hardcoded API keys in source | critical | 10 |

### Output Quality (14 criteria)

Tests that generated Chrome Extension artifacts are MV3-compliant and Chrome Web Store ready.

| ID | Name | Category | Weight |
|----|------|----------|--------|
| `quality_manifest_version_3` | manifest_version === 3 (MV3) | critical | 10 |
| `quality_manifest_required_fields` | all required manifest fields present | critical | 9 |
| `quality_manifest_action` | action field present | high | 8 |
| `quality_manifest_no_bg_page` | uses service_worker not page/scripts | critical | 9 |
| `quality_manifest_permissions_array` | permissions is array of strings | high | 7 |
| `quality_required_files` | all 4 core files present and non-empty | critical | 10 |
| `quality_popup_html_external_script` | popup.html uses <script src=...> | critical | 9 |
| `quality_popup_html_doctype` | popup.html has <!DOCTYPE html> | medium | 5 |
| `quality_bg_service_worker` | background.js declared as service_worker | high | 7 |
| `quality_permissions_match_blueprint` | manifest permissions ⊇ blueprint perms | high | 8 |
| `quality_blueprint_features` | blueprint features array valid | high | 7 |
| `quality_no_code_fences` | no markdown code fences in files | critical | 8 |
| `quality_manifest_valid_json` | manifest.json is valid JSON | critical | 10 |
| `quality_no_empty_files` | no empty or whitespace-only files | high | 7 |

### Performance (9 criteria)

Measures throughput, context efficiency, and runtime characteristics.

| ID | Name | Category | Weight |
|----|------|----------|--------|
| `perf_parallel_writes` | parallel writes faster than sequential | performance | 8 |
| `perf_grep_vs_read_all` | grep returns <30% of workspace chars | performance | 7 |
| `perf_file_versions_increment` | fileVersions append reducer merges | medium | 4 |
| `perf_qa_logs_append` | qa_logs append reducer no data loss | critical | 8 |
| `perf_token_budget_by_role` | per-role max_tokens budget enforced | performance | 7 |
| `perf_compaction_node` | context compaction node present | performance | 6 |
| `perf_retry_count_guard` | qa_retry_count upper bound guard | critical | 9 |
| `perf_bus_event_throughput` | event bus publishes all event types | high | 6 |
| `perf_bus_unsubscribe` | event bus unsubscribe stops delivery | medium | 5 |

### State Integrity (7 criteria)

Validates LangGraph state reducers and default values.

| ID | Name | Category | Weight |
|----|------|----------|--------|
| `state_defaults_correct` | all field defaults have correct types | critical | 8 |
| `state_scalar_last_write_wins` | scalar fields use last-write-wins | critical | 8 |
| `state_qa_logs_append` | qa_logs reducer appends entries | critical | 9 |
| `state_file_versions_merge` | fileVersions reducer merges maps | high | 6 |
| `state_blueprint_null_default` | blueprint defaults to null | high | 5 |
| `state_status_valid_values` | all 4 status values defined | medium | 4 |
| `state_all_channels_present` | all required channels declared | high | 7 |

---

## Output Files

JSON reports are saved to `eval-results/` (git-ignored). File naming:

```
eval-results/
└── eval-2025-12-01T14-30-00-a1b2c3d4.json
```

Each report contains:

```json
{
  "evalVersion": "2.0.0",
  "sidekickVersion": "1.0.0",
  "runId": "uuid",
  "timestamp": "ISO-8601",
  "totalDurationMs": 1234,
  "results": [...],
  "summary": {
    "overallScore": 94.3,
    "categoryScores": { "critical": 96.1, "high": 93.2, "medium": 97.0, "performance": 88.5 },
    "totalTests": 85,
    "passed": 80,
    "failed": 5,
    "criticalFailures": [],
    "grade": "A"
  }
}
```

---

## Adding New Criteria

1. Add the eval function to the appropriate file in `criteria/`
2. Export it from the `*_CRITERIA` array at the bottom of that file
3. Update this EVAL.md with the new entry in the catalogue table
4. Run `npm run eval` to verify it passes

Criterion function signature:
```typescript
export async function evalMyNewCriteria(): Promise<Omit<EvalResult, "durationMs">> {
  // ... measure something
  return {
    id: "category_short_name",       // machine-readable, snake_case
    name: "human-readable description",
    category: "critical" | "high" | "medium" | "performance",
    weight: 1–10,                    // relative importance
    score: 0–100,                    // achieved score
    threshold: 80 | 100,             // minimum passing score
    passed: score >= threshold,
    details: "one-line explanation of what happened",
  };
}
```

---

## Baseline Scores (v1.0.0 — 2026-05-21)

| Category | Score | Grade |
|----------|-------|-------|
| critical | 97.9% | S |
| high | 98.0% | S |
| medium | 98.2% | S |
| performance | 87.5% | A |
| **overall** | **97.3%** | **S** |

85 criteria total — 84 passed, 1 failed (performance: `perf_grep_vs_read_all` at 50%, stretch goal on tiny fixtures).

---

## CI Integration

Add to your CI pipeline:

```yaml
- name: Run Sidekick Eval
  run: npm run eval -- --no-save
  # Exits 1 if any CRITICAL criteria fail
```

---

*Eval suite version: 2.0.0 — bump evalVersion in reporter.ts when criteria change.*
