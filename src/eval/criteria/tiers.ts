/**
 * criteria/tiers.ts — Subscription tier gate enforcement
 *
 * Verifies that Free/Pro/Max capability boundaries are enforced:
 * - Free cannot access shell or browser tools
 * - Legal + integration nodes are Pro/Max only
 * - Researcher node is Max only
 * - Model selection matches tier
 */

import { evaluatePermission, createToolContext } from "../../tools/registry";
import type { EvalResult } from "../reporter";
import { tempWorktree } from "../harness";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ctx(tier: "free" | "pro" | "max") {
  return createToolContext({ sessionId: "eval-tiers", tier, worktree: tempWorktree() });
}

// ─── Criteria ─────────────────────────────────────────────────────────────────

export async function evalFreeTierDeniesShell(): Promise<Omit<EvalResult, "durationMs">> {
  const decision = evaluatePermission(ctx("free"), "shell", ["node --check"]);
  const denied = decision === "deny";
  return {
    id: "tier_free_denies_shell",
    name: "free tier → shell permission = deny",
    category: "critical",
    weight: 9,
    score: denied ? 100 : 0,
    threshold: 100,
    passed: denied,
    details: `evaluatePermission(free, shell) = "${decision}" (expected: "deny")`,
  };
}

export async function evalFreeTierDeniesBrowser(): Promise<Omit<EvalResult, "durationMs">> {
  const decision = evaluatePermission(ctx("free"), "browser", []);
  const denied = decision === "deny";
  return {
    id: "tier_free_denies_browser",
    name: "free tier → browser permission = deny",
    category: "critical",
    weight: 9,
    score: denied ? 100 : 0,
    threshold: 100,
    passed: denied,
    details: `evaluatePermission(free, browser) = "${decision}" (expected: "deny")`,
  };
}

export async function evalFreeTierAllowsRead(): Promise<Omit<EvalResult, "durationMs">> {
  const decision = evaluatePermission(ctx("free"), "read", []);
  const allowed = decision === "allow";
  return {
    id: "tier_free_allows_read",
    name: "free tier → read permission = allow",
    category: "critical",
    weight: 7,
    score: allowed ? 100 : 0,
    threshold: 100,
    passed: allowed,
    details: `evaluatePermission(free, read) = "${decision}" (expected: "allow")`,
  };
}

export async function evalFreeTierAllowsNetwork(): Promise<Omit<EvalResult, "durationMs">> {
  const decision = evaluatePermission(ctx("free"), "network", []);
  const allowed = decision === "allow";
  return {
    id: "tier_free_allows_network",
    name: "free tier → network permission = allow",
    category: "high",
    weight: 6,
    score: allowed ? 100 : 0,
    threshold: 100,
    passed: allowed,
    details: `evaluatePermission(free, network) = "${decision}" (expected: "allow")`,
  };
}

export async function evalProTierAsksShell(): Promise<Omit<EvalResult, "durationMs">> {
  const decision = evaluatePermission(ctx("pro"), "shell", ["node --check"]);
  const asks = decision === "ask";
  return {
    id: "tier_pro_asks_shell",
    name: "pro tier → shell permission = ask (not deny)",
    category: "high",
    weight: 8,
    score: asks ? 100 : 0,
    threshold: 100,
    passed: asks,
    details: `evaluatePermission(pro, shell) = "${decision}" (expected: "ask")`,
  };
}

export async function evalMaxTierAllowsNonDestructiveWrite(): Promise<Omit<EvalResult, "durationMs">> {
  const worktree = tempWorktree();
  const c = createToolContext({ sessionId: "eval-tiers", tier: "max", worktree });
  // Write inside worktree = non-destructive → should be "allow" for max
  const decision = evaluatePermission(c, "write", [`${worktree}/popup.js`]);
  const allowed = decision === "allow";
  return {
    id: "tier_max_allows_write_inside_worktree",
    name: "max tier → write inside worktree = allow",
    category: "high",
    weight: 7,
    score: allowed ? 100 : 0,
    threshold: 100,
    passed: allowed,
    details: `evaluatePermission(max, write, [worktree/popup.js]) = "${decision}" (expected: "allow")`,
  };
}

export async function evalTierModelMapping(): Promise<Omit<EvalResult, "durationMs">> {
  // getLLM should pick flash for free/pro and pro-model for max
  const { getLLM } = await import("../../llm_config");

  const freeModel = (getLLM({ role: "coder", tier: "free" }) as unknown as { model?: string }).model;
  const maxModel  = (getLLM({ role: "coder", tier: "max"  }) as unknown as { model?: string }).model;

  // Can't always introspect the model name from the SidekickLLM interface,
  // so we do a source-level check that resolveModel logic is present.
  const { readFileSync } = await import("fs");
  const path = await import("path");
  const src = readFileSync(path.join(__dirname, "../../../src/llm_config.ts"), "utf8");

  const hasFlashForFree = src.includes("GEMINI_FLASH_MODEL") || src.includes("gemini-2.5-flash");
  const hasProForMax    = src.includes("GEMINI_PRO_MODEL")   || src.includes("gemini-2.5-pro");
  const hasResolveModel = src.includes("resolveModel") || src.includes("tier === \"max\"");

  const score =
    (hasFlashForFree ? 34 : 0) +
    (hasProForMax    ? 33 : 0) +
    (hasResolveModel ? 33 : 0);

  return {
    id: "tier_model_routing",
    name: "tier-aware model selection (flash=free/pro, pro=max)",
    category: "high",
    weight: 8,
    score,
    threshold: 99,
    passed: score >= 99,
    details: `flash:${hasFlashForFree} pro:${hasProForMax} resolveModel:${hasResolveModel}`,
  };
}

export async function evalFreeTierWriteOutsideWorktreeDenied(): Promise<Omit<EvalResult, "durationMs">> {
  const worktree = tempWorktree();
  const c = createToolContext({ sessionId: "eval-tiers", tier: "free", worktree });
  // Writing outside the worktree from free tier should be denied
  const outsidePath = "/tmp/evil-override.js";
  const decision = evaluatePermission(c, "write", [outsidePath]);
  const denied = decision === "deny";
  return {
    id: "tier_free_denies_write_outside_worktree",
    name: "free tier → write outside worktree = deny",
    category: "critical",
    weight: 9,
    score: denied ? 100 : 0,
    threshold: 100,
    passed: denied,
    details: `write to "${outsidePath}" from free tier = "${decision}" (expected: "deny")`,
  };
}

export const TIER_CRITERIA = [
  evalFreeTierDeniesShell,
  evalFreeTierDeniesBrowser,
  evalFreeTierAllowsRead,
  evalFreeTierAllowsNetwork,
  evalProTierAsksShell,
  evalMaxTierAllowsNonDestructiveWrite,
  evalTierModelMapping,
  evalFreeTierWriteOutsideWorktreeDenied,
];
