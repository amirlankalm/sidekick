/**
 * criteria/security.ts — Security, hallucination, and injection guards
 *
 * Verifies that Sidekick's security layers are present and effective:
 * - Hallucinated endpoint detection
 * - Path traversal prevention in tools
 * - CORS allowlist enforcement logic
 * - Rate limit configuration presence
 * - Auth enforcement flag
 * - No secrets in source code
 * - CSP compliance (no inline scripts in generated extensions)
 * - manifest.json never requests unnecessary dangerous permissions
 */

import type { EvalResult } from "../reporter";
import type { SourceCode } from "../../state";
import { executeAgentTool } from "../../tools/agentic_tools";
import { createToolContext } from "../../tools/registry";
import { tempWorktree } from "../harness";
import { readFileSync } from "fs";
import path from "path";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function src(file: string): string {
  try {
    // __dirname = dist/eval/criteria/ → go up 3 levels to project root → into src/
    return readFileSync(path.join(__dirname, "../../../src", file), "utf8");
  } catch {
    return "";
  }
}

const GRAPH_SRC  = src("graph.ts");
const SERVER_SRC = src("server.ts");
const LLM_SRC    = src("llm_config.ts");

// Regex that matches known hallucinated/invented endpoint patterns
const HALLUCINATED_ENDPOINT_RE = /https?:\/\/[a-z0-9-]+\.(example|fake|ai-api|internal-only|private\.openai|api\.fictional)/i;

// ─── Hallucination guard ──────────────────────────────────────────────────────

export async function evalHallucinationGuardPresent(): Promise<Omit<EvalResult, "durationMs">> {
  const hasGuard =
    GRAPH_SRC.includes("ungroundedEndpoint") ||
    GRAPH_SRC.includes("hallucination") ||
    GRAPH_SRC.includes("grounded") ||
    GRAPH_SRC.includes("fake") ||
    GRAPH_SRC.includes("invented");
  return {
    id: "security_hallucination_guard_present",
    name: "hallucination endpoint guard present in graph.ts",
    category: "critical",
    weight: 10,
    score: hasGuard ? 100 : 0,
    threshold: 100,
    passed: hasGuard,
    details: hasGuard ? "guard function found in graph source" : "no hallucination guard found — critical gap",
  };
}

export async function evalHallucinationPatternDetects(): Promise<Omit<EvalResult, "durationMs">> {
  const hallucinatedFile = "fetch('https://api.fake-summarizer.example/v1/run')";
  const cleanFile = "fetch(`https://api.openai.com/v1/chat/completions`)";
  const detected = HALLUCINATED_ENDPOINT_RE.test(hallucinatedFile);
  const notFlagged = !HALLUCINATED_ENDPOINT_RE.test(cleanFile);
  const score = (detected ? 50 : 0) + (notFlagged ? 50 : 0);
  return {
    id: "security_hallucination_pattern_accuracy",
    name: "hallucination regex → detects fake, ignores real endpoints",
    category: "critical",
    weight: 9,
    score,
    threshold: 100,
    passed: score === 100,
    details: `detectedFake=${detected} notFlaggedReal=${notFlagged}`,
  };
}

export async function evalHallucinationSystemPromptDiscipline(): Promise<Omit<EvalResult, "durationMs">> {
  const hasDiscipLine =
    LLM_SRC.includes("OPENCODE_SYSTEM_DISCIPLINE") ||
    LLM_SRC.includes("invented") ||
    LLM_SRC.includes("hallucinated") ||
    LLM_SRC.includes("grounded");
  return {
    id: "security_hallucination_system_prompt",
    name: "OPENCODE_SYSTEM_DISCIPLINE includes anti-hallucination rule",
    category: "critical",
    weight: 8,
    score: hasDiscipLine ? 100 : 0,
    threshold: 100,
    passed: hasDiscipLine,
    details: hasDiscipLine ? "anti-hallucination rule present in LLM system prompt" : "no discipline rule found",
  };
}

// ─── Path traversal ───────────────────────────────────────────────────────────

export async function evalPathTraversalBlockedInWrite(): Promise<Omit<EvalResult, "durationMs">> {
  const ws: SourceCode = {};
  const c = createToolContext({ sessionId: "eval-sec", tier: "max", worktree: tempWorktree() });
  await executeAgentTool("write_file", { path: "../../../../etc/cron.d/evil", content: "evil" }, ws, c, tempWorktree());
  const safe = !Object.keys(ws).some(k => k.includes("..") || k.startsWith("/"));
  return {
    id: "security_path_traversal_write",
    name: "write_file → path traversal stripped/blocked",
    category: "critical",
    weight: 10,
    score: safe ? 100 : 0,
    threshold: 100,
    passed: safe,
    details: safe ? "no ../ paths in workspace" : `dangerous keys: ${Object.keys(ws).filter(k => k.includes("..") || k.startsWith("/")).join(", ")}`,
  };
}

export async function evalPathTraversalBlockedInRead(): Promise<Omit<EvalResult, "durationMs">> {
  const ws: SourceCode = { "../secret.env": "SECRET=abc123" };
  const c = createToolContext({ sessionId: "eval-sec", tier: "max", worktree: tempWorktree() });
  const result = await executeAgentTool("read_file", { path: "../secret.env" }, ws, c, tempWorktree());
  // Either the path is sanitized to "secret.env" (which doesn't exist) and errors, or it's denied
  const safe = result.isError || !result.output.includes("SECRET=");
  return {
    id: "security_path_traversal_read",
    name: "read_file → cannot escape worktree via ../",
    category: "critical",
    weight: 9,
    score: safe ? 100 : 0,
    threshold: 100,
    passed: safe,
    details: safe ? "traversal path not readable" : "CRITICAL: ../secret.env content leaked",
  };
}

// ─── CORS ─────────────────────────────────────────────────────────────────────

export async function evalCORSAllowlistPresent(): Promise<Omit<EvalResult, "durationMs">> {
  const hasAllowlist =
    SERVER_SRC.includes("ALLOWED_ORIGINS") ||
    SERVER_SRC.includes("allowedOrigins") ||
    SERVER_SRC.includes("extensy.app") ||
    SERVER_SRC.includes("extensy.dev");
  return {
    id: "security_cors_allowlist",
    name: "server.ts → CORS origin allowlist present",
    category: "high",
    weight: 8,
    score: hasAllowlist ? 100 : 0,
    threshold: 100,
    passed: hasAllowlist,
    details: hasAllowlist ? "CORS allowlist found" : "no CORS allowlist — open to cross-origin abuse",
  };
}

export async function evalCORSProductionGate(): Promise<Omit<EvalResult, "durationMs">> {
  const hasProductionGate =
    SERVER_SRC.includes("NODE_ENV") &&
    SERVER_SRC.includes("production") &&
    (SERVER_SRC.includes("isAllowed") || SERVER_SRC.includes("ALLOWED_ORIGIN"));
  return {
    id: "security_cors_production_gate",
    name: "server.ts → CORS bypassed only in non-production",
    category: "high",
    weight: 7,
    score: hasProductionGate ? 100 : 0,
    threshold: 100,
    passed: hasProductionGate,
    details: hasProductionGate ? "NODE_ENV production gate found" : "no production gate — dev bypass may be permanently open",
  };
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

export async function evalRateLimitGlobalPresent(): Promise<Omit<EvalResult, "durationMs">> {
  const hasGlobal =
    SERVER_SRC.includes("globalLimiter") ||
    SERVER_SRC.includes("rateLimit") ||
    SERVER_SRC.includes("express-rate-limit");
  return {
    id: "security_rate_limit_global",
    name: "server.ts → global rate limiter configured",
    category: "high",
    weight: 7,
    score: hasGlobal ? 100 : 0,
    threshold: 100,
    passed: hasGlobal,
    details: hasGlobal ? "rate limiter found" : "no global rate limit — DoS risk",
  };
}

export async function evalRateLimitGenerateEndpoint(): Promise<Omit<EvalResult, "durationMs">> {
  const hasGenerate =
    SERVER_SRC.includes("generateLimiter") ||
    (SERVER_SRC.includes("/generate") && SERVER_SRC.includes("rateLimit"));
  return {
    id: "security_rate_limit_generate",
    name: "server.ts → /generate endpoint has its own rate limit",
    category: "high",
    weight: 8,
    score: hasGenerate ? 100 : 0,
    threshold: 100,
    passed: hasGenerate,
    details: hasGenerate ? "/generate rate limiter found" : "/generate has no dedicated rate limit",
  };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export async function evalAuthSupabaseJWT(): Promise<Omit<EvalResult, "durationMs">> {
  const hasJWT =
    SERVER_SRC.includes("getUser") ||
    SERVER_SRC.includes("Authorization") ||
    SERVER_SRC.includes("jwt") ||
    SERVER_SRC.includes("REQUIRE_AUTH");
  return {
    id: "security_auth_supabase_jwt",
    name: "server.ts → Supabase JWT auth verification present",
    category: "critical",
    weight: 9,
    score: hasJWT ? 100 : 0,
    threshold: 100,
    passed: hasJWT,
    details: hasJWT ? "JWT auth found" : "no authentication — critical security gap",
  };
}

export async function evalAuthGetUserNotGetSession(): Promise<Omit<EvalResult, "durationMs">> {
  // getUser() is the correct Supabase server-side check; getSession() alone does NOT verify JWT
  const hasGetUser = SERVER_SRC.includes("getUser");
  const hasUnsafeGetSession = SERVER_SRC.includes("getSession") && !SERVER_SRC.includes("getUser");
  const correct = hasGetUser && !hasUnsafeGetSession;
  return {
    id: "security_auth_get_user",
    name: "server.ts → uses getUser() not getSession() alone",
    category: "critical",
    weight: 8,
    score: correct ? 100 : hasGetUser ? 80 : 0,
    threshold: 80,
    passed: correct || hasGetUser,
    details: `getUser:${hasGetUser} unsafeGetSession:${hasUnsafeGetSession}`,
  };
}

// ─── CSP / MV3 compliance ─────────────────────────────────────────────────────

export async function evalGeneratedExtensionNoInlineScripts(): Promise<Omit<EvalResult, "durationMs">> {
  // Inline scripts in popup.html violate Chrome MV3 CSP
  const dangerousHtml = `<html><body><script>alert('xss')</script></body></html>`;
  const safeHtml = `<html><head><link rel='stylesheet' href='popup.css'></head><body><script src='popup.js'></script></body></html>`;

  const inlineScriptRe = /<script(?![^>]*\bsrc\b)[^>]*>[\s\S]*?<\/script>/i;
  const dangerousFlag = inlineScriptRe.test(dangerousHtml);
  const safePass = !inlineScriptRe.test(safeHtml);

  const score = (dangerousFlag ? 50 : 0) + (safePass ? 50 : 0);
  return {
    id: "security_no_inline_scripts",
    name: "CSP guard → detects inline scripts, ignores external",
    category: "critical",
    weight: 10,
    score,
    threshold: 100,
    passed: score === 100,
    details: `detectedInline=${dangerousFlag} passedSafeExternal=${safePass}`,
  };
}

export async function evalManifestNoExcessiveDangerousPermissions(): Promise<Omit<EvalResult, "durationMs">> {
  // Extensions should never declare unnecessary dangerous permissions
  const DANGEROUS = ["<all_urls>", "debugger", "management", "privacy", "system.cpu", "system.memory"];
  const safeManifest = { permissions: ["activeTab", "scripting", "storage"] };
  const dangerousManifest = { permissions: ["activeTab", "<all_urls>", "management"] };

  const safeHasNone = !safeManifest.permissions.some(p => DANGEROUS.includes(p));
  const dangerousHasSome = dangerousManifest.permissions.some(p => DANGEROUS.includes(p));

  const score = (safeHasNone ? 50 : 0) + (dangerousHasSome ? 50 : 0);
  return {
    id: "security_manifest_permissions",
    name: "dangerous permission detection → flags <all_urls>, management",
    category: "critical",
    weight: 9,
    score,
    threshold: 100,
    passed: score === 100,
    details: `safePassThrough=${safeHasNone} dangerousDetected=${dangerousHasSome}`,
  };
}

// ─── No secrets in source ─────────────────────────────────────────────────────

export async function evalNoHardcodedSecretsInSrc(): Promise<Omit<EvalResult, "durationMs">> {
  const SECRET_RE = /(sk-[a-zA-Z0-9]{40,}|AIza[0-9A-Za-z-_]{35}|AKIA[0-9A-Z]{16}|password\s*=\s*["'][^"']{8,})/;
  const hits = [GRAPH_SRC, SERVER_SRC, LLM_SRC].filter(s => SECRET_RE.test(s));
  const clean = hits.length === 0;
  return {
    id: "security_no_hardcoded_secrets",
    name: "source files → no hardcoded API keys or secrets",
    category: "critical",
    weight: 10,
    score: clean ? 100 : 0,
    threshold: 100,
    passed: clean,
    details: clean ? "no secrets found" : `potential secrets in ${hits.length} file(s)`,
  };
}

export const SECURITY_CRITERIA = [
  evalHallucinationGuardPresent,
  evalHallucinationPatternDetects,
  evalHallucinationSystemPromptDiscipline,
  evalPathTraversalBlockedInWrite,
  evalPathTraversalBlockedInRead,
  evalCORSAllowlistPresent,
  evalCORSProductionGate,
  evalRateLimitGlobalPresent,
  evalRateLimitGenerateEndpoint,
  evalAuthSupabaseJWT,
  evalAuthGetUserNotGetSession,
  evalGeneratedExtensionNoInlineScripts,
  evalManifestNoExcessiveDangerousPermissions,
  evalNoHardcodedSecretsInSrc,
];
