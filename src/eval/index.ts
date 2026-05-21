/**
 * eval/index.ts — Sidekick Comprehensive Eval Suite
 *
 * Entry point for the full evaluation run. Loads all criterion modules,
 * executes each eval function, aggregates weighted scores per category,
 * and outputs both a rich console report and a JSON file for historical
 * comparison across Sidekick versions.
 *
 * Usage:
 *   npm run eval                    # full run, JSON saved to eval-results/
 *   npm run eval -- --no-save       # full run, no JSON output
 *   npm run eval -- --category=critical   # run only one category
 *   npm run eval -- --filter=security     # run criteria whose id contains "security"
 *
 * Exit codes:
 *   0 — all CRITICAL criteria passed
 *   1 — one or more CRITICAL criteria failed (blocks ship)
 *   2 — error in eval harness itself
 */

import { readFileSync } from "fs";
import path from "path";
import { buildReport, printReport, saveReport, runEval, type EvalResult } from "./reporter";

// ─── All criterion modules ─────────────────────────────────────────────────────

import { PIPELINE_CRITERIA }    from "./criteria/pipeline";
import { TIER_CRITERIA }        from "./criteria/tiers";
import { TOOLS_CRITERIA }       from "./criteria/tools";
import { SCHEMA_CRITERIA }      from "./criteria/schemas";
import { SECURITY_CRITERIA }    from "./criteria/security";
import { QUALITY_CRITERIA }     from "./criteria/quality";
import { PERFORMANCE_CRITERIA } from "./criteria/performance";
import { STATE_CRITERIA }       from "./criteria/state";

const ALL_CRITERIA = [
  ...PIPELINE_CRITERIA,
  ...TIER_CRITERIA,
  ...TOOLS_CRITERIA,
  ...SCHEMA_CRITERIA,
  ...SECURITY_CRITERIA,
  ...QUALITY_CRITERIA,
  ...PERFORMANCE_CRITERIA,
  ...STATE_CRITERIA,
];

// ─── CLI argument parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const noSave       = args.includes("--no-save");
const categoryArg  = args.find(a => a.startsWith("--category="))?.split("=")[1];
const filterArg    = args.find(a => a.startsWith("--filter="))?.split("=")[1];

// ─── Sidekick version ─────────────────────────────────────────────────────────

function getSidekickVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function main() {
  const selected = ALL_CRITERIA.filter(fn => {
    if (filterArg && !fn.name.toLowerCase().includes(filterArg.toLowerCase())) return false;
    return true;
  });

  console.log(`\nSidekick Eval — running ${selected.length} criteria...\n`);

  const results: EvalResult[] = [];
  const start = Date.now();
  let i = 0;

  for (const fn of selected) {
    i++;
    process.stdout.write(`  [${String(i).padStart(2, "0")}/${selected.length}] ${fn.name.replace(/^eval/, "")}...`);
    try {
      const result = await runEval(fn);

      // Category filter applied after running (so we still execute but can filter report)
      if (categoryArg && result.category !== categoryArg) {
        process.stdout.write(" (skipped)\n");
        continue;
      }

      results.push(result);
      const icon = result.passed ? "✓" : "✗";
      process.stdout.write(` ${icon} ${result.score}%  (${result.durationMs}ms)\n`);
    } catch (err) {
      // Eval harness error — record as zero score
      process.stdout.write(` ✗ HARNESS ERROR\n`);
      results.push({
        id: `harness_error_${fn.name}`,
        name: fn.name,
        category: "critical",
        weight: 1,
        score: 0,
        threshold: 100,
        passed: false,
        details: `harness threw: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: 0,
      });
    }
  }

  const totalMs = Date.now() - start;
  const report = buildReport(results, totalMs, getSidekickVersion());

  printReport(report);

  if (!noSave) {
    const outDir = path.join(__dirname, "..", "..", "eval-results");
    const saved = await saveReport(report, outDir);
    console.log(`  Report saved to: ${saved}\n`);
  }

  // Exit 1 if any CRITICAL criteria failed
  const hasCriticalFailure = report.summary.criticalFailures.length > 0;
  process.exit(hasCriticalFailure ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal eval error:", err);
  process.exit(2);
});
