/**
 * reporter.ts — Eval scoring engine and output formatter
 *
 * Aggregates EvalResult entries into a weighted score per category,
 * prints a structured console report, and serialises the run to JSON
 * so scores can be compared across Sidekick versions.
 */

import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvalCategory = "critical" | "high" | "medium" | "performance";

export interface EvalResult {
  /** Short machine-readable id, e.g. "mv3_manifest_version" */
  id: string;
  /** Human-readable name shown in the report */
  name: string;
  category: EvalCategory;
  /** Relative importance 1–10 within the category */
  weight: number;
  /** Achieved score 0–100. Partial credit allowed. */
  score: number;
  /** Minimum score to be considered passing */
  threshold: number;
  passed: boolean;
  /** One-line explanation: what was measured and what happened */
  details: string;
  durationMs: number;
}

export interface EvalReport {
  /** Eval suite version — bump when criteria change */
  evalVersion: string;
  /** sidekick-engine package.json version */
  sidekickVersion: string;
  runId: string;
  timestamp: string;
  totalDurationMs: number;
  results: EvalResult[];
  summary: {
    overallScore: number;
    categoryScores: Record<EvalCategory, number>;
    totalTests: number;
    passed: number;
    failed: number;
    criticalFailures: string[];
    grade: "S" | "A" | "B" | "C" | "D" | "F";
  };
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

const CATEGORY_WEIGHTS: Record<EvalCategory, number> = {
  critical:    0.40,
  high:        0.30,
  medium:      0.15,
  performance: 0.15,
};

function weightedScore(results: EvalResult[], category: EvalCategory): number {
  const subset = results.filter(r => r.category === category);
  if (subset.length === 0) return 100;
  const totalWeight = subset.reduce((s, r) => s + r.weight, 0);
  const earned = subset.reduce((s, r) => s + r.weight * r.score, 0);
  return Math.round((earned / totalWeight) * 10) / 10;
}

function grade(score: number): EvalReport["summary"]["grade"] {
  if (score >= 97) return "S";
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export function buildReport(
  results: EvalResult[],
  totalDurationMs: number,
  sidekickVersion: string
): EvalReport {
  const categoryScores: Record<EvalCategory, number> = {
    critical:    weightedScore(results, "critical"),
    high:        weightedScore(results, "high"),
    medium:      weightedScore(results, "medium"),
    performance: weightedScore(results, "performance"),
  };

  const overallScore = Math.round(
    (Object.entries(CATEGORY_WEIGHTS) as [EvalCategory, number][]).reduce(
      (sum, [cat, w]) => sum + categoryScores[cat] * w,
      0
    ) * 10
  ) / 10;

  const criticalFailures = results
    .filter(r => r.category === "critical" && !r.passed)
    .map(r => r.id);

  const passed = results.filter(r => r.passed).length;

  return {
    evalVersion: "2.0.0",
    sidekickVersion,
    runId: randomUUID(),
    timestamp: new Date().toISOString(),
    totalDurationMs,
    results,
    summary: {
      overallScore,
      categoryScores,
      totalTests: results.length,
      passed,
      failed: results.length - passed,
      criticalFailures,
      grade: grade(overallScore),
    },
  };
}

// ─── Console renderer ─────────────────────────────────────────────────────────

const W = 78;
const line = "─".repeat(W);
const dline = "═".repeat(W);

function padRight(s: string, n: number) {
  return s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}
function padLeft(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s.padStart(n);
}

const CATEGORY_LABELS: Record<EvalCategory, string> = {
  critical:    "CRITICAL",
  high:        "HIGH    ",
  medium:      "MEDIUM  ",
  performance: "PERF    ",
};

export function printReport(report: EvalReport): void {
  const { summary, results } = report;

  console.log("\n");
  console.log("╔" + dline + "╗");
  console.log("║  SIDEKICK EVAL — COMPREHENSIVE PERFORMANCE REPORT" + " ".repeat(W - 50) + "║");
  console.log("║  Eval v" + report.evalVersion + "  ·  Sidekick v" + report.sidekickVersion + "  ·  " + report.timestamp.slice(0, 19).replace("T", " ") + " UTC" + " ".repeat(W - 65) + "║");
  console.log("╠" + dline + "╣");

  // Category scores
  for (const cat of (["critical", "high", "medium", "performance"] as EvalCategory[])) {
    const s = summary.categoryScores[cat];
    const bar = "█".repeat(Math.round(s / 5)) + "░".repeat(20 - Math.round(s / 5));
    const label = CATEGORY_LABELS[cat];
    const scoreStr = `${s.toFixed(1)}%`;
    const flag = s < 100 && cat === "critical" ? " ⚠" : s >= 90 ? " ✓" : s >= 70 ? " ~" : " ✗";
    console.log(`║  ${label}  ${bar}  ${padLeft(scoreStr, 7)}${flag}` + " ".repeat(W - 44) + "║");
  }

  console.log("╠" + dline + "╣");

  // Overall
  const g = summary.grade;
  const gradeLabel = `Grade: ${g}`;
  const scoreLabel = `Overall Score: ${summary.overallScore.toFixed(1)}%`;
  const passLabel = `${summary.passed}/${summary.totalTests} passed`;
  const timeLabel = `${(report.totalDurationMs / 1000).toFixed(2)}s`;
  console.log("║  " + scoreLabel.padEnd(24) + gradeLabel.padEnd(14) + passLabel.padEnd(18) + timeLabel.padEnd(W - 56) + "  ║");

  if (summary.criticalFailures.length > 0) {
    console.log("╠" + dline + "╣");
    console.log("║  ⚠  CRITICAL FAILURES (score capped to F until resolved):" + " ".repeat(W - 56) + "║");
    for (const id of summary.criticalFailures) {
      console.log("║    ✗ " + padRight(id, W - 6) + "  ║");
    }
  }

  console.log("╠" + dline + "╣");

  // Detailed results per category
  for (const cat of (["critical", "high", "medium", "performance"] as EvalCategory[])) {
    const subset = results.filter(r => r.category === cat);
    if (subset.length === 0) continue;
    console.log("║  ── " + CATEGORY_LABELS[cat].trim() + " (" + subset.length + " criteria)" + " ".repeat(W - 24 - CATEGORY_LABELS[cat].trim().length - String(subset.length).length) + "║");
    for (const r of subset) {
      const tick = r.passed ? "✓" : "✗";
      const name = padRight(r.name, 44);
      const score = padLeft(`${r.score}%`, 5);
      const dur = padLeft(`${r.durationMs}ms`, 7);
      console.log(`║    ${tick} ${name} ${score}  ${dur}` + " ".repeat(W - 62) + "║");
      if (!r.passed) {
        const detail = padRight("    → " + r.details, W - 2);
        console.log("║  " + detail + "║");
      }
    }
  }

  console.log("╚" + dline + "╝");
  console.log("\n");
}

// ─── JSON persistence ─────────────────────────────────────────────────────────

export async function saveReport(report: EvalReport, outputDir: string): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const filename = `eval-${report.timestamp.replace(/[:.]/g, "-").slice(0, 19)}-${report.runId.slice(0, 8)}.json`;
  const outPath = path.join(outputDir, filename);
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  return outPath;
}

// ─── Eval runner helper ───────────────────────────────────────────────────────

type EvalFn = () => Promise<Omit<EvalResult, "durationMs">>;

export async function runEval(fn: EvalFn): Promise<EvalResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, durationMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Propagate so caller knows what happened
    throw new Error(`eval fn threw: ${msg}`);
  }
}
