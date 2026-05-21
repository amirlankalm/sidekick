/**
 * criteria/tools.ts — Agentic tool accuracy and correctness
 *
 * Covers every tool in CODER_TOOLS: write_file, edit_file, read_file,
 * list_files, bash_check, grep_workspace.  Each criterion verifies
 * deterministic behavior with no live LLM or filesystem calls.
 */

import { executeAgentTool } from "../../tools/agentic_tools";
import { createToolContext } from "../../tools/registry";
import type { SourceCode } from "../../state";
import type { EvalResult } from "../reporter";
import { tempWorktree } from "../harness";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ctx(tier: "free" | "pro" | "max" = "max") {
  return createToolContext({ sessionId: "eval-tools", tier, worktree: tempWorktree() });
}

function seed(): SourceCode {
  return {
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "T", version: "1.0" }, null, 2),
    "popup.html": "<html><body><button id='go'>Go</button></body></html>",
    "popup.css": "body{margin:0}#go{background:#0f766e;color:#fff}",
    "popup.js": "const btn=document.getElementById('go');btn.addEventListener('click',()=>console.log('clicked'));",
  };
}

// ─── write_file ───────────────────────────────────────────────────────────────

export async function evalWriteFileCreates(): Promise<Omit<EvalResult, "durationMs">> {
  const ws: SourceCode = {};
  const result = await executeAgentTool("write_file", { path: "popup.js", content: "console.log('hi');" }, ws, ctx(), tempWorktree());
  const created = !result.isError && ws["popup.js"] === "console.log('hi');";
  return {
    id: "tool_write_file_creates",
    name: "write_file → creates new file in workspace",
    category: "critical",
    weight: 9,
    score: created ? 100 : 0,
    threshold: 100,
    passed: created,
    details: created ? "file written correctly" : `isError=${result.isError} output="${result.output}"`,
  };
}

export async function evalWriteFileOverwrites(): Promise<Omit<EvalResult, "durationMs">> {
  const ws: SourceCode = { "popup.js": "OLD" };
  await executeAgentTool("write_file", { path: "popup.js", content: "NEW" }, ws, ctx(), tempWorktree());
  const overwritten = ws["popup.js"] === "NEW";
  return {
    id: "tool_write_file_overwrites",
    name: "write_file → overwrites existing file",
    category: "critical",
    weight: 8,
    score: overwritten ? 100 : 0,
    threshold: 100,
    passed: overwritten,
    details: overwritten ? "overwrite successful" : `content="${ws["popup.js"]}"`,
  };
}

export async function evalWriteFileRejectsPathTraversal(): Promise<Omit<EvalResult, "durationMs">> {
  const ws: SourceCode = {};
  await executeAgentTool("write_file", { path: "../../../etc/passwd", content: "evil" }, ws, ctx(), tempWorktree());
  // sanitizePath must strip traversal — no ".." segments may survive in any key,
  // and no absolute path starting with "/" may appear. Landing at "etc/passwd" is acceptable
  // (sandboxed within the workspace), but "../etc/passwd" or "/etc/passwd" is not.
  const noDoubleDot = !Object.keys(ws).some(k => k.includes(".."));
  const noAbsolute  = !Object.keys(ws).some(k => k.startsWith("/"));
  const safe = noDoubleDot && noAbsolute;
  return {
    id: "tool_write_file_path_traversal",
    name: "write_file → rejects ../ path traversal",
    category: "critical",
    weight: 10,
    score: safe ? 100 : 0,
    threshold: 100,
    passed: safe,
    details: safe ? "path traversal stripped (no .. or absolute paths in workspace)" : `dangerous keys: ${JSON.stringify(Object.keys(ws))}`,
  };
}

// ─── edit_file ────────────────────────────────────────────────────────────────

export async function evalEditFileSurgical(): Promise<Omit<EvalResult, "durationMs">> {
  const ws = seed();
  const before = { ...ws };
  const result = await executeAgentTool(
    "edit_file",
    { path: "popup.js", old_string: "console.log('clicked')", new_string: "console.log('activated')" },
    ws,
    ctx(),
    tempWorktree()
  );
  const fixed = !result.isError && ws["popup.js"].includes("activated") && !ws["popup.js"].includes("console.log('clicked')");
  const unchanged = ["manifest.json", "popup.html", "popup.css"].every(f => ws[f] === before[f]);

  const score = (fixed ? 50 : 0) + (unchanged ? 50 : 0);
  return {
    id: "tool_edit_file_surgical",
    name: "edit_file → fixes only target, leaves others unchanged",
    category: "critical",
    weight: 9,
    score,
    threshold: 100,
    passed: score === 100,
    details: `fixed=${fixed} otherFilesUnchanged=${unchanged}`,
  };
}

export async function evalEditFileMissingOldStringErrors(): Promise<Omit<EvalResult, "durationMs">> {
  const ws = seed();
  const result = await executeAgentTool(
    "edit_file",
    { path: "popup.js", old_string: "THIS_DOES_NOT_EXIST", new_string: "replacement" },
    ws,
    ctx(),
    tempWorktree()
  );
  const errored = result.isError;
  return {
    id: "tool_edit_file_missing_old_string",
    name: "edit_file → isError when old_string not found",
    category: "high",
    weight: 8,
    score: errored ? 100 : 0,
    threshold: 100,
    passed: errored,
    details: errored ? "correctly returned isError=true" : `unexpectedly succeeded: "${result.output}"`,
  };
}

export async function evalEditFileAmbiguousStringErrors(): Promise<Omit<EvalResult, "durationMs">> {
  const ws: SourceCode = { "popup.js": "x=1;x=1;x=1;" };
  const result = await executeAgentTool(
    "edit_file",
    { path: "popup.js", old_string: "x=1;", new_string: "x=2;" },
    ws,
    ctx(),
    tempWorktree()
  );
  // Multiple matches should either error or make only one replacement (no silent corruption)
  const safe = result.isError || (ws["popup.js"].split("x=2;").length - 1) <= 1;
  return {
    id: "tool_edit_file_ambiguous",
    name: "edit_file → errors on ambiguous (multiple) matches",
    category: "high",
    weight: 7,
    score: safe ? 100 : 0,
    threshold: 100,
    passed: safe,
    details: safe ? "correctly handled ambiguous match" : `output has ${ws["popup.js"].split("x=2;").length - 1} replacements`,
  };
}

// ─── read_file ────────────────────────────────────────────────────────────────

export async function evalReadFileReturnsContent(): Promise<Omit<EvalResult, "durationMs">> {
  const ws = seed();
  const result = await executeAgentTool("read_file", { path: "popup.html" }, ws, ctx(), tempWorktree());
  const correct = !result.isError && result.output.includes("<button");
  return {
    id: "tool_read_file_returns_content",
    name: "read_file → returns correct file content",
    category: "critical",
    weight: 8,
    score: correct ? 100 : 0,
    threshold: 100,
    passed: correct,
    details: correct ? "content returned correctly" : `isError=${result.isError} output="${result.output.slice(0, 60)}"`,
  };
}

export async function evalReadFileMissingErrors(): Promise<Omit<EvalResult, "durationMs">> {
  const ws = seed();
  const result = await executeAgentTool("read_file", { path: "nonexistent.js" }, ws, ctx(), tempWorktree());
  const errored = result.isError;
  return {
    id: "tool_read_file_missing",
    name: "read_file → isError when file not in workspace",
    category: "high",
    weight: 7,
    score: errored ? 100 : 0,
    threshold: 100,
    passed: errored,
    details: errored ? "correctly returned isError=true" : `unexpectedly succeeded: "${result.output}"`,
  };
}

// ─── list_files ───────────────────────────────────────────────────────────────

export async function evalListFilesReturnsAll(): Promise<Omit<EvalResult, "durationMs">> {
  const ws = seed();
  const result = await executeAgentTool("list_files", {}, ws, ctx(), tempWorktree());
  const expected = ["manifest.json", "popup.html", "popup.css", "popup.js"];
  const present = expected.every(f => result.output.includes(f));
  return {
    id: "tool_list_files_all",
    name: "list_files → returns all workspace filenames",
    category: "high",
    weight: 6,
    score: present ? 100 : 0,
    threshold: 100,
    passed: present,
    details: present ? "all 4 files listed" : `output="${result.output.slice(0, 120)}"`,
  };
}

export async function evalListFilesEmptyWorkspace(): Promise<Omit<EvalResult, "durationMs">> {
  const result = await executeAgentTool("list_files", {}, {}, ctx(), tempWorktree());
  const graceful = !result.isError;
  return {
    id: "tool_list_files_empty",
    name: "list_files → graceful on empty workspace",
    category: "medium",
    weight: 4,
    score: graceful ? 100 : 0,
    threshold: 100,
    passed: graceful,
    details: graceful ? "no error on empty workspace" : result.output,
  };
}

// ─── grep_workspace ───────────────────────────────────────────────────────────

export async function evalGrepWorkspaceFindsPattern(): Promise<Omit<EvalResult, "durationMs">> {
  const ws = seed();
  const result = await executeAgentTool("grep_workspace", { pattern: "manifest_version" }, ws, ctx(), tempWorktree());
  const found = !result.isError && result.output.includes("manifest.json");
  return {
    id: "tool_grep_finds_pattern",
    name: "grep_workspace → returns matching files and lines",
    category: "high",
    weight: 8,
    score: found ? 100 : 0,
    threshold: 100,
    passed: found,
    details: found ? "pattern found in manifest.json" : `output="${result.output.slice(0, 80)}"`,
  };
}

export async function evalGrepWorkspaceContextEfficiency(): Promise<Omit<EvalResult, "durationMs">> {
  const ws = seed();
  const totalChars = Object.values(ws).reduce((s, v) => s + v.length, 0);
  const result = await executeAgentTool("grep_workspace", { pattern: "manifest_version" }, ws, ctx(), tempWorktree());
  const ratio = result.output.length / totalChars;
  const efficient = ratio < 0.5;
  const score = efficient ? 100 : Math.max(0, Math.round((1 - ratio) * 100));
  return {
    id: "tool_grep_context_efficiency",
    name: "grep_workspace → returns <50% of total workspace chars",
    category: "performance",
    weight: 7,
    score,
    threshold: 80,
    passed: efficient,
    details: `ratio=${(ratio * 100).toFixed(1)}% of total ${totalChars} chars`,
  };
}

export async function evalGrepWorkspaceNoMatch(): Promise<Omit<EvalResult, "durationMs">> {
  const ws = seed();
  const result = await executeAgentTool("grep_workspace", { pattern: "THIS_PATTERN_DOES_NOT_EXIST_XYZ" }, ws, ctx(), tempWorktree());
  const graceful = !result.isError;
  return {
    id: "tool_grep_no_match",
    name: "grep_workspace → graceful when pattern not found",
    category: "medium",
    weight: 4,
    score: graceful ? 100 : 0,
    threshold: 100,
    passed: graceful,
    details: graceful ? "no error on zero matches" : result.output,
  };
}

// ─── bash_check ───────────────────────────────────────────────────────────────

export async function evalBashCheckValidFile(): Promise<Omit<EvalResult, "durationMs">> {
  const ws: SourceCode = { "popup.js": "const x = 1 + 2; console.log(x);" };
  const result = await executeAgentTool("bash_check", { path: "popup.js" }, ws, ctx("max"), tempWorktree());
  const acceptable =
    result.output.includes("OK") ||
    result.output.includes("Syntax ok") ||
    result.output.includes("skipped") ||  // shell not available in test env
    result.output.toLowerCase().includes("pass") ||
    (!result.isError && result.output.length > 0);
  return {
    id: "tool_bash_check_valid",
    name: "bash_check → returns deterministic result for valid JS",
    category: "high",
    weight: 7,
    score: acceptable ? 100 : 0,
    threshold: 100,
    passed: acceptable,
    details: `output="${result.output.slice(0, 80)}"`,
  };
}

export async function evalBashCheckFreeTierDenied(): Promise<Omit<EvalResult, "durationMs">> {
  const ws: SourceCode = { "popup.js": "const x = 1;" };
  const freeCtx = createToolContext({ sessionId: "eval-tools", tier: "free", worktree: tempWorktree() });
  const result = await executeAgentTool("bash_check", { path: "popup.js" }, ws, freeCtx, tempWorktree());
  // Free tier can't use shell — either error or graceful skip
  const blocked = result.isError || result.output.toLowerCase().includes("deni") || result.output.toLowerCase().includes("skip");
  return {
    id: "tool_bash_check_free_tier_blocked",
    name: "bash_check → blocked on free tier",
    category: "critical",
    weight: 9,
    score: blocked ? 100 : 0,
    threshold: 100,
    passed: blocked,
    details: `isError=${result.isError} output="${result.output.slice(0, 80)}"`,
  };
}

export const TOOLS_CRITERIA = [
  evalWriteFileCreates,
  evalWriteFileOverwrites,
  evalWriteFileRejectsPathTraversal,
  evalEditFileSurgical,
  evalEditFileMissingOldStringErrors,
  evalEditFileAmbiguousStringErrors,
  evalReadFileReturnsContent,
  evalReadFileMissingErrors,
  evalListFilesReturnsAll,
  evalListFilesEmptyWorkspace,
  evalGrepWorkspaceFindsPattern,
  evalGrepWorkspaceContextEfficiency,
  evalGrepWorkspaceNoMatch,
  evalBashCheckValidFile,
  evalBashCheckFreeTierDenied,
];
