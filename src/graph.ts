/**
 * graph.ts — Extensy / Sidekick Core LangGraph Pipeline
 *
 * Implements the full agentic graph that:
 *   1. Routes by subscription tier and planning intent
 *   2. Plans (architect_node) & researches (researcher_node, Max only)
 *   3. Generates source code (coder_node)
 *   4. Self-heals via Playwright QA loop (qa_node → qa_router → coder_node)
 *   5. Fans out to legal_node / integration_node in parallel (Pro/Max)
 *   6. Assembles the final Chrome Extension ZIP (assembler_node)
 *
 * ┌──────────────┐    planning+Pro/Max    ┌────────────────┐
 * │ initial_node │──────────────────────→│ architect_node │
 * │  (router)    │                        └───────┬────────┘
 * │              │──── Free OR !planning  ──────→ │
 * └──────────────┘                       ┌────────▼────────┐     Max only
 *                                        │ researcher_node │──→ (Nia API)
 *                                        └────────┬────────┘
 *                                                 │
 *                                        ┌────────▼────────┐
 *                                        │   coder_node    │ ←─ QA errors
 *                                        └────────┬────────┘
 *                                                 │
 *                                        ┌────────▼────────┐
 *                                        │    qa_node      │
 *                                        └────────┬────────┘
 *                                                 │ errors → coder_node
 *                                                 │ clean  ↓
 *                                   ┌─────────────┼──────────────┐
 *                                Free│          Pro│          Max│
 *                           ┌────────▼┐    ┌──────▼──────┐  ┌───▼──────────┐
 *                           │assembler│    │ legal_node  │  │legal+integr. │
 *                           └─────────┘    └──────┬──────┘  └───┬──────────┘
 *                                                  └──────┬──────┘
 *                                                  ┌──────▼──────┐
 *                                                  │  assembler  │
 *                                                  └─────────────┘
 */

import "dotenv/config";
import path from "path";
import fs from "fs/promises";
import os from "os";
import net from "net";
import * as crypto from "crypto";
import { chromium as playwrightChromium } from "playwright-core";
import sparticuzChromium from "@sparticuz/chromium";
import { StateGraph, END, START } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip";

import {
  StateAnnotation,
  type ExtensyState,
  type QALogEntry,
  type Blueprint,
  type SourceCode,
  type PromoBrief,
  type PublishingBrief,
  type DesignBrief,
  type SidekickPlan,
} from "./state";
import {
  getArchitectLLM,
  getCoderLLM,
  getLegalLLM,
  getUIDesignerLLM,
  getDecomposerLLM,
  OPENCODE_SYSTEM_DISCIPLINE,
  type ApiMessage,
} from "./llm_config";
import { CODER_TOOLS, executeAgentTool } from "./tools/agentic_tools";
import { runDevToolsDiagnostics } from "./devtools_mcp";
import { logger } from "./logger";
import {
  BlueprintSchema,
  DesignBriefSchema,
  SidekickPlanSchema,
  SourceCodeSchema,
  validateSchema,
} from "./schemas";
import { bus } from "./bus";
import { getNiaClient } from "./nia";
import { createToolContext, evaluatePermission, type ToolContext } from "./tools/registry";
import { launchPersistentContext, mkdir, rm, runCommand, writeTextFile } from "./tools/wrappers";
import { parallelBatch } from "./tools/batch";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max number of QA→coder retry cycles before aborting (prevents inf. loops) */
const MAX_QA_RETRIES = 3;

/**
 * Max agentic loop steps inside coder_node per subscription tier.
 * OpenCode reference: agent.steps field in agent definitions.
 * Free tier gets fewer steps (cost control); Max tier gets more for complex builds.
 */
const MAX_AGENT_STEPS: Record<string, number> = {
  free: 3,
  pro: 6,
  max: 9,
};

/** Directory where Playwright loads the extension under test */
const TMP_EXT_DIR = path.join(os.tmpdir(), "sidekick", "extension");

/** Where the assembled ZIP is written (local dev only; skipped on Vercel) */
const OUTPUT_DIR = path.join(os.tmpdir(), "sidekick", "output");
const SIDEKICK_WORKTREE = path.join(os.tmpdir(), "sidekick");
const ALLOWED_DOC_HOSTS = new Set([
  "developer.chrome.com",
  "chrome.jscn.org",
  "developer.mozilla.org",
  "docs.github.com",
  "docs.stripe.com",
  "platform.openai.com",
  "developers.notion.com",
  "supabase.com",
  "docs.supabase.com",
]);
/** Maps permission names → official Chrome API reference pages (deterministic grounding) */
const CHROME_API_DOC_URLS: Record<string, string> = {
  scripting:    "https://developer.chrome.com/docs/extensions/reference/api/scripting",
  storage:      "https://developer.chrome.com/docs/extensions/reference/api/storage",
  tabs:         "https://developer.chrome.com/docs/extensions/reference/api/tabs",
  activeTab:    "https://developer.chrome.com/docs/extensions/develop/concepts/activeTab",
  notifications:"https://developer.chrome.com/docs/extensions/reference/api/notifications",
  alarms:       "https://developer.chrome.com/docs/extensions/reference/api/alarms",
  contextMenus: "https://developer.chrome.com/docs/extensions/reference/api/contextMenus",
  identity:     "https://developer.chrome.com/docs/extensions/reference/api/identity",
  cookies:      "https://developer.chrome.com/docs/extensions/reference/api/cookies",
  downloads:    "https://developer.chrome.com/docs/extensions/reference/api/downloads",
  history:      "https://developer.chrome.com/docs/extensions/reference/api/history",
  bookmarks:    "https://developer.chrome.com/docs/extensions/reference/api/bookmarks",
};

/**
 * Builds targeted Nia search queries from the blueprint.
 * Queries are designed to retrieve grounding context that prevents the coder
 * from hallucinating API signatures, endpoint URLs, or CSP-breaking patterns.
 */
function buildNiaQueries(state: ExtensyState): string[] {
  const blueprint = state.blueprint;
  const permissions = blueprint?.permissions ?? [];
  const features    = blueprint?.features    ?? [];
  const connectors  = blueprint?.connectors  ?? [];
  const profile     = blueprint?.design_profile ?? "Editorial Utility";

  const queries: string[] = [];

  // 1. Chrome API method signatures — top hallucination source
  const primaryPerm = permissions[0];
  queries.push(
    primaryPerm
      ? `Chrome Extension MV3 chrome.${primaryPerm} exact method signatures parameters return types code example`
      : "Chrome Extension MV3 activeTab scripting executeScript API exact signatures content scripts"
  );

  // 2. MV3 CSP constraints — prevents inline-script / eval / remote-code hallucinations
  queries.push(
    "Chrome Extension Manifest V3 content security policy no inline scripts no eval service worker background removed declarativeNetRequest"
  );

  // 3. Design tokens for the specific profile — grounds the UI designer
  queries.push(
    `${profile} CSS design tokens hex color palette spacing 4px scale popup 360px system font stack minimal editorial`
  );

  // 4. Feature-level grounding
  if (features.length > 0) {
    queries.push(
      features.slice(0, 2).map(f => f.summary.slice(0, 100)).join(" | ") +
      " Chrome Extension MV3 implementation pattern"
    );
  }

  // 5. Connector-specific grounding
  if (connectors.includes("supabase")) {
    queries.push("Supabase REST API Authorization Bearer apikey header fetch auth signIn select insert Chrome extension");
  } else if (connectors.includes("stripe")) {
    queries.push("Stripe Payment Link publishable key redirect URL chrome.tabs.create billing Chrome extension");
  }

  return queries.slice(0, 5);
}

type ConnectorKind = "supabase" | "stripe";
type LegalDocKind = "terms-of-service" | "privacy-policy";

// ---------------------------------------------------------------------------
// Supabase client (used by legal_node to persist the TOS document)
// ---------------------------------------------------------------------------

type SupabaseOverrideFn = (() => unknown) | null;
let supabaseClientOverride: SupabaseOverrideFn = null;

function getSupabaseClient() {
  if (supabaseClientOverride) return supabaseClientOverride() as ReturnType<typeof createClient>;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "[graph] SUPABASE_URL or SUPABASE_ANON_KEY is missing from environment"
    );
  }
  return createClient(url, key);
}

export function setSupabaseClientForTests(factory: () => unknown): void {
  supabaseClientOverride = factory;
}

export function resetSupabaseClientForTests(): void {
  supabaseClientOverride = null;
}

// ---------------------------------------------------------------------------
// Helper: write source_code map to disk
// ---------------------------------------------------------------------------

/**
 * Materialises every file in the SourceCode map into TMP_EXT_DIR.
 * Existing files are overwritten — this is deliberate so that QA retries
 * always test the freshest generated code.
 */
function configureNodeContext(state: ExtensyState): ToolContext {
  return createToolContext({
    sessionId: state.requestId,
    tier: state.subscription_tier,
    worktree: SIDEKICK_WORKTREE,
    directory: SIDEKICK_WORKTREE,
  });
}

function publishPhase(state: ExtensyState, node: string, message: string): void {
  bus.publish({ type: "phase.started", requestId: state.requestId, node, message });
}

async function writeExtensionToDisk(ctx: ToolContext, sourceCode: SourceCode): Promise<void> {
  await mkdir(ctx, TMP_EXT_DIR);

  await parallelBatch(
    ctx,
    Object.entries(sourceCode).map(([relativePath, content]) => ({
      tool: "fs.writeFile",
      args: { path: relativePath, size: Buffer.byteLength(content) },
      async run() {
    const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const absolute = path.resolve(TMP_EXT_DIR, normalizedPath);
    if (!absolute.startsWith(`${TMP_EXT_DIR}${path.sep}`) && absolute !== TMP_EXT_DIR) {
      throw new Error(`[graph] Refusing to write file outside extension root: ${relativePath}`);
    }
        await writeTextFile(ctx, absolute, content);
      },
    })),
    5
  );

  logger.info("Extension written to disk", {
    node: "writeExtensionToDisk",
    fileCount: Object.keys(sourceCode).length,
    dir: TMP_EXT_DIR,
  });
}

function detectRequiredConnectors(state: ExtensyState): ConnectorKind[] {
  const fromBlueprint = state.blueprint?.connectors ?? [];
  const haystack = [
    state.user_prompt,
    state.blueprint?.description,
    state.blueprint?.raw_requirements,
    state.research_context,
    ...Object.values(state.source_code),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  const connectors = new Set<ConnectorKind>(
    fromBlueprint.filter((connector): connector is ConnectorKind =>
      connector === "supabase" || connector === "stripe"
    )
  );

  if (
    /\bsupabase\b/.test(haystack) ||
    /\b(auth|sign in|signin|sign up|signup|session|user account|database|postgres|table|row level security|rls)\b/.test(haystack)
  ) {
    connectors.add("supabase");
  }

  if (
    /\bstripe\b/.test(haystack) ||
    /\b(payment|payments|checkout|subscription|billing|purchase|paywall|premium plan)\b/.test(haystack)
  ) {
    connectors.add("stripe");
  }

  return [...connectors];
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

function parseJsonPayload<T>(raw: string): T {
  return JSON.parse(extractJsonPayload(raw)) as T;
}

function toKebabCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractHttpsHosts(input: string): Set<string> {
  const hosts = new Set<string>();
  const urlPattern = /https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>)\\]*)?/gi;
  let match: RegExpExecArray | null;

  while ((match = urlPattern.exec(input)) !== null) {
    try {
      hosts.add(new URL(match[0]).hostname.toLowerCase());
    } catch {
      // Ignore malformed URL-like strings; runtime/schema validation catches real breakage.
    }
  }

  return hosts;
}

function buildEndpointGroundingText(state: ExtensyState): string {
  const blueprint = state.blueprint;
  return [
    state.user_prompt,
    state.research_context,
    blueprint?.description,
    blueprint?.raw_requirements,
    ...(blueprint?.features ?? []).flatMap((feature) => [
      feature.summary,
      feature.implementation_hint ?? "",
    ]),
  ]
    .filter(Boolean)
    .join("\n");
}

function findUngroundedExternalEndpoints(
  sourceCode: SourceCode,
  state: ExtensyState
): string[] {
  const generatedText = Object.values(sourceCode).join("\n");
  const groundingHosts = extractHttpsHosts(buildEndpointGroundingText(state));
  const generatedUrls = generatedText.match(/https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s"'`<>)\\]*)?/gi) ?? [];
  const ungrounded = new Set<string>();

  for (const rawUrl of generatedUrls) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".local")) continue;
      if (groundingHosts.has(host)) continue;
      ungrounded.add(rawUrl);
    } catch {
      // Ignore malformed URL-like strings.
    }
  }

  return [...ungrounded];
}

function resolveGeneratedExtensionName(sourceCode: SourceCode, state: ExtensyState): string {
  const manifestSource = sourceCode["manifest.json"];
  if (manifestSource) {
    try {
      const manifest = JSON.parse(manifestSource) as { name?: string };
      if (manifest.name?.trim()) return manifest.name.trim();
    } catch {}
  }

  return state.blueprint?.name?.trim() || "Extensy Extension";
}

function needsPopupRepair(sourceCode: SourceCode): boolean {
  const popupHtml = sourceCode["popup.html"];
  if (!popupHtml) return true;
  if (popupHtml.includes('data-extensy-polished="true"')) return false;

  const css = [
    sourceCode["popup.css"],
    sourceCode["styles.css"],
    sourceCode["style.css"],
  ].filter(Boolean).join("\n");

  if (!css.trim()) return true;
  if (!/<!doctype html>|<html[\s>]/i.test(popupHtml)) return true;
  if (!/<body[\s>]/i.test(popupHtml)) return true;
  if (!/<button[\s\S]*id=["']primary-action["']/i.test(popupHtml)) return true;
  if (!/aria-label=["']Status["']/i.test(popupHtml)) return true;
  if (!/--(surface|bg|ink|text|primary)\s*:/i.test(css)) return true;
  if (!/min-height\s*:\s*(4[0-9]{2}|[5-9][0-9]{2})px/i.test(css)) return true;
  if (!/transition\s*:/i.test(css)) return true;
  if (/@tailwind\b|@apply\b|class=["'][^"']*\b(text-|bg-|p-|px-|py-|mt-|rounded-|duration-|ease-|active:|hover:)/i.test(`${popupHtml}\n${css}`)) {
    return true;
  }

  return false;
}


function ensurePremiumPopup(sourceCode: SourceCode, state: ExtensyState): SourceCode {
  if (!needsPopupRepair(sourceCode)) return sourceCode;

  const name = resolveGeneratedExtensionName(sourceCode, state);
  const description =
    state.blueprint?.description ||
    "A focused browser utility generated by Extensy.";
  const primaryFeature =
    state.blueprint?.features?.[0]?.summary ||
    "Ready to run on matching pages.";
  const permissions = (() => {
    try {
      const manifest = JSON.parse(sourceCode["manifest.json"] ?? "{}") as { permissions?: string[] };
      return (manifest.permissions ?? []).slice(0, 3);
    } catch {
      return [];
    }
  })();

  const popupHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(name)}</title>
  <link rel="stylesheet" href="popup.css" />
</head>
<body>
  <main class="shell" data-extensy-polished="true">
    <header class="hero">
      <div class="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" role="img">
          <path d="M5 4.5h9.8c2.8 0 4.7 1.8 4.7 4.3 0 2.1-1.3 3.7-3.3 4.2l3.9 6.5h-4.3l-3.5-6.1H9v6.1H5V4.5Zm4 6h5.1c.9 0 1.5-.6 1.5-1.5s-.6-1.5-1.5-1.5H9v3Z" />
        </svg>
      </div>
      <div>
        <p class="eyebrow">Chrome extension</p>
        <h1>${escapeHtml(name)}</h1>
      </div>
    </header>

    <section class="summary" aria-label="Extension summary">
      <p>${escapeHtml(description)}</p>
    </section>

    <section class="status-grid" aria-label="Status">
      <div>
        <span class="label">State</span>
        <strong id="runtime-status">Active</strong>
      </div>
      <div>
        <span class="label">Scope</span>
        <strong>${permissions.length > 0 ? escapeHtml(permissions.join(", ")) : "Current tab"}</strong>
      </div>
    </section>

    <section class="feature">
      <span class="label">Behavior</span>
      <p>${escapeHtml(primaryFeature)}</p>
    </section>

    <footer>
      <button id="primary-action" type="button">
        <span>Run on this page</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 5 20 12l-6.5 7-1.4-1.3 4.2-4.7H4v-2h12.3l-4.2-4.7L13.5 5Z" /></svg>
      </button>
      <p id="action-note" class="note">Open a page that matches this extension, then run it from the toolbar.</p>
    </footer>
  </main>
  <script src="popup.js"></script>
</body>
</html>`;

  const popupCss = `:root {
  color-scheme: light;
  --bg: #f5f5f4;
  --surface: #ffffff;
  --ink: #0f0f0f;
  --ink-2: #3d3d3d;
  --muted: #8c8c8c;
  --border: #e8e8e7;
}

*,
*::before,
*::after { box-sizing: border-box; margin: 0; padding: 0; }

html,
body {
  min-width: 360px;
  min-height: 480px;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

body { display: grid; place-items: start stretch; }

.shell {
  width: 360px;
  min-height: 480px;
  background: var(--surface);
  display: flex;
  flex-direction: column;
}

.hero {
  padding: 18px 20px 16px;
  display: flex;
  align-items: center;
  gap: 11px;
  border-bottom: 1px solid var(--border);
}

.mark {
  width: 32px;
  height: 32px;
  background: var(--ink);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.mark svg {
  width: 16px;
  height: 16px;
  fill: #ffffff;
}

.eyebrow {
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
  line-height: 1;
  margin-bottom: 3px;
}

h1 {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: -0.015em;
  color: var(--ink);
}

.summary {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}

.summary p {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
}

.status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--border);
}

.status-grid > div {
  padding: 12px 20px;
}

.status-grid > div + div {
  border-left: 1px solid var(--border);
}

.label {
  font-size: 9.5px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--muted);
  display: block;
  margin-bottom: 4px;
}

strong {
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--ink);
}

.feature {
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}

.feature p {
  margin-top: 4px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ink-2);
}

footer {
  margin-top: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

button {
  width: 100%;
  height: 38px;
  padding: 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--ink);
  color: #ffffff;
  border: none;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
  cursor: pointer;
  transition: opacity 100ms ease;
}

button:hover { opacity: 0.82; }
button:active { opacity: 0.65; }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

button svg {
  width: 13px;
  height: 13px;
  fill: currentColor;
  opacity: 0.55;
}

.note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}`;

  const popupJs = sourceCode["popup.js"] && /getElementById\(['"]primary-action/.test(sourceCode["popup.js"])
    ? sourceCode["popup.js"]
    : `document.addEventListener("DOMContentLoaded", () => {
  const button = document.getElementById("primary-action");
  const note = document.getElementById("action-note");
  const status = document.getElementById("runtime-status");

  button?.addEventListener("click", async () => {
    status.textContent = "Triggered";
    note.textContent = "If this extension has a content script, Chrome will run it on matching pages.";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id && chrome.scripting) {
        const manifest = chrome.runtime.getManifest();
        const script = manifest.content_scripts?.[0]?.js?.[0];
        if (script) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [script] });
      }
    } catch {
      note.textContent = "Open a regular webpage, then run the extension again.";
    }
  });
});`;

  return {
    ...sourceCode,
    "popup.html": popupHtml,
    "popup.css": popupCss,
    "popup.js": popupJs,
  };
}

function renderLegalDocumentHtml(params: {
  title: string;
  appName: string;
  author: string;
  body: string;
}): string {
  const paragraphs = params.body
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length === 1) {
        return `<p>${escapeHtml(lines[0])}</p>`;
      }
      const [first, ...rest] = lines;
      return `<section><h2>${escapeHtml(first)}</h2><p>${escapeHtml(rest.join(" "))}</p></section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(params.title)} | ${escapeHtml(params.appName)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f1e8;
      --panel: #fcfaf5;
      --ink: #1f1914;
      --muted: #6c6056;
      --accent: #0f766e;
      --line: rgba(31, 25, 20, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--ink);
      line-height: 1.65;
    }
    main {
      max-width: 860px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }
    header {
      display: grid;
      gap: 8px;
      margin-bottom: 32px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      font-size: 12px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--accent);
    }
    h1, h2 { margin: 0; line-height: 1.1; }
    h1 { font-size: clamp(2.2rem, 6vw, 3.8rem); letter-spacing: -0.04em; }
    h2 { font-size: 1.1rem; margin-bottom: 12px; letter-spacing: -0.02em; }
    p { margin: 0 0 16px; color: var(--ink); }
    section { margin-bottom: 24px; }
    .meta { color: var(--muted); font-size: 0.95rem; }
    .shell {
      background: var(--panel);
      border: 1px solid var(--line);
      padding: 28px;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">${escapeHtml(params.appName)}</div>
      <h1>${escapeHtml(params.title)}</h1>
      <div class="meta">Publisher: ${escapeHtml(params.author)}</div>
    </header>
    <div class="shell">
      ${paragraphs}
    </div>
  </main>
</body>
</html>`;
}

async function uploadLegalDocument(params: {
  supabase: ReturnType<typeof getSupabaseClient>;
  author: string;
  docId: string;
  kind: LegalDocKind;
  content: string;
  contentType: string;
}): Promise<string> {
  const fileName = `legal/${params.author}/${params.kind}/${params.docId}.html`;
  const { error } = await params.supabase.storage
    .from("legal-docs")
    .upload(fileName, Buffer.from(params.content, "utf-8"), {
      contentType: params.contentType,
      upsert: true,
    });

  if (error) throw error;

  const { data } = params.supabase.storage.from("legal-docs").getPublicUrl(fileName);
  if (!data?.publicUrl) {
    throw new Error(`[legal_node] Missing public URL for ${fileName}`);
  }

  return data.publicUrl;
}

const DESIGN_PROFILE_MAP: Array<[pattern: string, label: string]> = [
  ["editorial",   "Editorial Utility"],
  ["minimal",     "Apple Minimalist"],
  ["apple",       "Apple Minimalist"],
  ["linear",      "Linear Dark"],
  ["dark",        "Linear Dark"],
  ["stripe",      "Stripe Vibrant"],
  ["vibrant",     "Stripe Vibrant"],
  ["developer",   "Developer Tools"],
  ["enterprise",  "Enterprise Clean"],
  ["glass",       "Glassmorphism"],
];

function getDesignDirection(profile?: string): string {
  const normalized = (profile || "").toLowerCase();
  for (const [pattern, label] of DESIGN_PROFILE_MAP) {
    if (normalized.includes(pattern)) return label;
  }
  return "Editorial Utility";
}

function buildPromoBrief(state: ExtensyState): PromoBrief {
  const blueprint = state.blueprint;
  const extensionName = blueprint?.name ?? "This Extension";
  const description = blueprint?.description ?? state.user_prompt;
  const tagline = description.length > 110 ? `${description.slice(0, 107)}...` : description;
  const features = (blueprint?.features ?? [])
    .map((feature) => feature.summary.trim())
    .filter(Boolean)
    .slice(0, 5);
  const permissions = blueprint?.permissions ?? [];
  const audience = /developer|github|api|debug/i.test(description)
    ? "Developers and technical operators who need focused browser workflows."
    : "Knowledge workers who want a cleaner, faster browser workflow.";

  return {
    design_direction: getDesignDirection(blueprint?.design_profile),
    palette: ["#f5f1e8", "#fcfaf5", "#1f1914", "#0f766e"],
    tagline,
    audience,
    slides: [
      {
        title: extensionName,
        body: tagline,
        visual_focus: "Editorial hero with asymmetrical composition, mono metadata, and the primary task front and center.",
      },
      {
        title: "What It Solves",
        body: features[0] ?? "Focus the browser workflow around a single high-value task.",
        visual_focus: "Clean product framing with one dominant workflow panel and restrained annotation callouts.",
      },
      {
        title: "Core Workflow",
        body: features[1] ?? features[0] ?? "Show the main loop the user repeats every day inside the extension.",
        visual_focus: "Step-based editorial layout showing input, processing state, and result.",
      },
      {
        title: "Built For Real Use",
        body: features[2] ?? `Permissions and integrations are tailored to ${extensionName}, not stock boilerplate.`,
        visual_focus: `Precision detail slide highlighting ${permissions.slice(0, 3).join(", ") || "extension capabilities"} with utility-style labels.`,
      },
      {
        title: "Why It Feels Better",
        body: features[3] ?? features[4] ?? "The UI is designed as an editorial utility: calm, focused, and specific to the job.",
        visual_focus: "Refined closing slide with quiet typography, focused controls, and no generic marketing clutter.",
      },
    ],
  };
}

function buildPublishingBrief(state: ExtensyState): PublishingBrief {
  const blueprint = state.blueprint;
  const extensionName = blueprint?.name ?? "This Extension";
  const shortDescriptionBase = blueprint?.description ?? state.user_prompt;
  const shortDescription = shortDescriptionBase.length > 132
    ? `${shortDescriptionBase.slice(0, 129)}...`
    : shortDescriptionBase;
  const featureLines = (blueprint?.features ?? [])
    .map((feature) => `- ${feature.summary}`)
    .slice(0, 6);
  const permissions = blueprint?.permissions ?? [];
  const hostPermissions = blueprint?.host_permissions ?? [];
  const privacyPractices = [
    permissions.includes("storage")
      ? "Stores extension settings and user workflow state locally in Chrome extension storage."
      : "Does not rely on persistent local storage beyond what Chrome requires for runtime behavior.",
    detectRequiredConnectors(state).includes("supabase")
      ? "Uses Supabase-backed authentication or data sync only when the product requires signed-in workflows."
      : "Does not require backend account storage unless explicitly requested by the product flow.",
    hostPermissions.length > 0
      ? `Makes external requests only to declared host permissions: ${hostPermissions.join(", ")}.`
      : "Does not call undeclared third-party hosts.",
  ];

  return {
    listing_title: extensionName,
    short_description: shortDescription,
    detailed_description: [
      shortDescriptionBase,
      "",
      ...featureLines,
    ].join("\n"),
    category_hint: /developer|github|api|debug/i.test(shortDescriptionBase) ? "Developer Tools" : "Productivity",
    permissions,
    host_permissions: hostPermissions,
    legal_urls: {
      terms_of_service: state.legal_url,
      privacy_policy: state.privacy_url,
    },
    privacy_practices_summary: privacyPractices,
    upload_readiness_checks: [
      "Confirm the extension ZIP loads cleanly without QA errors.",
      "Confirm the Terms of Service URL is publicly reachable without authentication.",
      "Confirm the Privacy Policy URL is publicly reachable without authentication.",
      "Provide screenshots and promo slides that match the generated extension UI, not generic marketing art.",
      "Review requested permissions against the listed product behavior before submission.",
    ],
  };
}

function buildConnectorFiles(connectors: ConnectorKind[]): SourceCode {
  if (connectors.length === 0) return {};

  const files: SourceCode = {
    "lib/extensy-connectors/config.js": `// REQUIRES_API_KEY: NEXT_PUBLIC_SUPABASE_URL - Supabase project URL for auth and database requests
// REQUIRES_API_KEY: NEXT_PUBLIC_SUPABASE_ANON_KEY - Supabase anon key used by the extension client
// REQUIRES_API_KEY: STRIPE_PUBLISHABLE_KEY - Stripe publishable key used for client-side checkout flows
// REQUIRES_API_KEY: STRIPE_PAYMENT_LINK - Optional Stripe payment link for instant hosted checkout
// REQUIRES_API_KEY: STRIPE_CHECKOUT_URL - Optional backend endpoint that creates a Stripe Checkout Session
export const CONNECTOR_CONFIG = {
  supabaseUrl: "__NEXT_PUBLIC_SUPABASE_URL__",
  supabaseAnonKey: "__NEXT_PUBLIC_SUPABASE_ANON_KEY__",
  stripePublishableKey: "__STRIPE_PUBLISHABLE_KEY__",
  stripePaymentLink: "__STRIPE_PAYMENT_LINK__",
  stripeCheckoutUrl: "__STRIPE_CHECKOUT_URL__",
};

export function readConnectorConfig(overrides = {}) {
  return {
    ...CONNECTOR_CONFIG,
    ...overrides,
  };
}
`,
    "SETUP_CONNECTORS.md": `# Extensy Connectors

This extension includes first-party Extensy connector scaffolding.

## Supabase
- Set NEXT_PUBLIC_SUPABASE_URL to your project URL
- Set NEXT_PUBLIC_SUPABASE_ANON_KEY to your anon key
- Use the provided Supabase connector for auth, session storage, and PostgREST queries

## Stripe
- Set STRIPE_PUBLISHABLE_KEY to your Stripe publishable key
- For the fastest setup, set STRIPE_PAYMENT_LINK to a hosted Stripe Payment Link
- If you need dynamic pricing, set STRIPE_CHECKOUT_URL to your own backend endpoint that creates Checkout Sessions

## Security Rules
- Never place a Stripe secret key in the extension
- Never place a Supabase service role key in the extension
- Keep privileged billing logic on your backend or in Supabase Edge Functions
`,
  };

  if (connectors.includes("supabase")) {
    files["lib/extensy-connectors/supabase.js"] = `import { readConnectorConfig } from "./config.js";

const SESSION_KEY = "extensy.supabase.session";

async function getStorageArea() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return chrome.storage.local;
  }
  return null;
}

async function readStoredSession() {
  const storage = await getStorageArea();
  if (storage) {
    const data = await storage.get(SESSION_KEY);
    return data[SESSION_KEY] ?? null;
  }
  const raw = globalThis.localStorage?.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

async function writeStoredSession(session) {
  const storage = await getStorageArea();
  if (storage) {
    await storage.set({ [SESSION_KEY]: session });
    return;
  }
  if (session) {
    globalThis.localStorage?.setItem(SESSION_KEY, JSON.stringify(session));
  } else {
    globalThis.localStorage?.removeItem(SESSION_KEY);
  }
}

function createHeaders(accessToken) {
  const { supabaseAnonKey } = readConnectorConfig();
  return {
    apikey: supabaseAnonKey,
    Authorization: accessToken ? \`Bearer \${accessToken}\` : \`Bearer \${supabaseAnonKey}\`,
    "Content-Type": "application/json",
  };
}

export function createSupabaseConnector(overrides = {}) {
  const config = readConnectorConfig(overrides);
  const baseUrl = config.supabaseUrl.replace(/\\/$/, "");

  async function request(path, init = {}) {
    const session = await readStoredSession();
    const response = await fetch(\`\${baseUrl}\${path}\`, {
      ...init,
      headers: {
        ...createHeaders(session?.access_token),
        ...(init.headers ?? {}),
      },
    });

    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(data?.msg || data?.error_description || data?.message || "Supabase request failed");
    }
    return data;
  }

  return {
    async signUp({ email, password, metadata = {} }) {
      return request("/auth/v1/signup", {
        method: "POST",
        body: JSON.stringify({ email, password, data: metadata }),
      });
    },
    async signIn({ email, password }) {
      const session = await request("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      await writeStoredSession(session);
      return session;
    },
    async signOut() {
      const session = await readStoredSession();
      if (session?.access_token) {
        await request("/auth/v1/logout", { method: "POST" });
      }
      await writeStoredSession(null);
    },
    async getSession() {
      return readStoredSession();
    },
    async select(table, query = "") {
      return request(\`/rest/v1/\${table}\${query}\`, {
        method: "GET",
        headers: { Prefer: "return=representation" },
      });
    },
    async insert(table, values) {
      return request(\`/rest/v1/\${table}\`, {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(values),
      });
    },
    async upsert(table, values, onConflict) {
      const query = onConflict ? \`?on_conflict=\${encodeURIComponent(onConflict)}\` : "";
      return request(\`/rest/v1/\${table}\${query}\`, {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(values),
      });
    },
  };
}
`;
  }

  if (connectors.includes("stripe")) {
    files["lib/extensy-connectors/stripe.js"] = `import { readConnectorConfig } from "./config.js";

export function createStripeConnector(overrides = {}) {
  const config = readConnectorConfig(overrides);

  function assertClientConfig() {
    if (!config.stripePublishableKey || config.stripePublishableKey === "YOUR_API_KEY_HERE") {
      throw new Error("Missing STRIPE_PUBLISHABLE_KEY");
    }
  }

  return {
    async startCheckout({ priceId, successUrl, cancelUrl, customerEmail, metadata = {} } = {}) {
      assertClientConfig();

      if (config.stripePaymentLink && config.stripePaymentLink !== "YOUR_API_KEY_HERE") {
        const target = new URL(config.stripePaymentLink);
        if (successUrl) target.searchParams.set("redirect_status", "succeeded");
        await chrome.tabs.create({ url: target.toString() });
        return { mode: "payment_link", url: target.toString() };
      }

      if (!config.stripeCheckoutUrl || config.stripeCheckoutUrl === "YOUR_API_KEY_HERE") {
        throw new Error("Set STRIPE_PAYMENT_LINK or STRIPE_CHECKOUT_URL before starting checkout");
      }

      const response = await fetch(config.stripeCheckoutUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stripe-Publishable-Key": config.stripePublishableKey,
        },
        body: JSON.stringify({
          priceId,
          successUrl,
          cancelUrl,
          customerEmail,
          metadata,
        }),
      });

      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error || "Stripe checkout initialization failed");
      }

      if (!data?.url) {
        throw new Error("Stripe checkout response did not include a redirect URL");
      }

      await chrome.tabs.create({ url: data.url });
      return { mode: "checkout_session", url: data.url };
    },
  };
}
`;
  }

  return files;
}

function patchManifestForConnectors(sourceCode: SourceCode, connectors: ConnectorKind[]): SourceCode {
  if (connectors.length === 0 || !sourceCode["manifest.json"]) return sourceCode;

  try {
    const manifest = JSON.parse(sourceCode["manifest.json"]) as {
      permissions?: string[];
      host_permissions?: string[];
      content_security_policy?: Record<string, string>;
    };

    const permissions = new Set(manifest.permissions ?? []);
    const hostPermissions = new Set(manifest.host_permissions ?? []);

    permissions.add("storage");

    if (connectors.includes("supabase")) {
      hostPermissions.add("https://*.supabase.co/*");
    }

    if (connectors.includes("stripe")) {
      hostPermissions.add("https://checkout.stripe.com/*");
      hostPermissions.add("https://buy.stripe.com/*");
    }

    manifest.permissions = [...permissions];
    manifest.host_permissions = [...hostPermissions];

    return {
      ...sourceCode,
      "manifest.json": JSON.stringify(manifest, null, 2),
    };
  } catch {
    return sourceCode;
  }
}

function normalizeGeneratedManifest(sourceCode: SourceCode): SourceCode {
  const manifestSource = sourceCode["manifest.json"];
  if (!manifestSource) return sourceCode;

  try {
    const manifest = JSON.parse(manifestSource) as {
      action?: { default_popup?: string; default_title?: string };
      name?: string;
      permissions?: string[];
      background?: { service_worker?: string };
    };
    const permissions = new Set(manifest.permissions ?? []);
    const allCode = Object.entries(sourceCode)
      .filter(([filename]) => filename.endsWith(".js"))
      .map(([, content]) => content)
      .join("\n");

    if (sourceCode["popup.html"]) {
      manifest.action = {
        default_title: manifest.action?.default_title ?? manifest.name ?? "Extension",
        ...manifest.action,
        default_popup: manifest.action?.default_popup ?? "popup.html",
      };
    }

    const backgroundPath = manifest.background?.service_worker;
    if (backgroundPath && !sourceCode[backgroundPath]) {
      delete manifest.background;
    } else if (!backgroundPath) {
      const generatedBackground = ["background.js", "backgroundScript.js"].find(
        (filename) => sourceCode[filename]
      );
      if (generatedBackground) {
        manifest.background = { service_worker: generatedBackground };
      }
    }

    if (allCode.includes("chrome.scripting.")) permissions.add("scripting");
    if (allCode.includes("chrome.tabs.")) permissions.add("tabs");
    if (allCode.includes("chrome.storage.")) permissions.add("storage");
    if (allCode.includes("chrome.notifications.")) permissions.add("notifications");

    manifest.permissions = [...permissions];

    return {
      ...sourceCode,
      "manifest.json": JSON.stringify(manifest, null, 2),
    };
  } catch {
    return sourceCode;
  }
}

function filterUIDesignerFiles(uiFiles: SourceCode, existingSource: SourceCode): SourceCode {
  const allowed = new Set(Object.keys(existingSource));
  allowed.add("popup.css");
  allowed.add("styles.css");

  return Object.fromEntries(
    Object.entries(uiFiles).filter(([filename]) => {
      if (filename === "manifest.json") return false;
      if (filename.startsWith("lib/")) return false;
      if (filename.startsWith("background")) return false;
      if (allowed.has(filename)) return true;
      return /(^|\/)(popup|options|sidepanel|content).*\.((html)|(css)|(js))$/i.test(filename);
    })
  );
}

function buildConnectorPrompt(connectors: ConnectorKind[]): string {
  if (connectors.length === 0) return "";

  const sections: string[] = [
    "## Extensy Connector Contract",
    "When auth, database, or payment features are required, use the first-party Extensy connector modules instead of inventing ad hoc integration code.",
  ];

  if (connectors.includes("supabase")) {
    sections.push(
      [
        "### Supabase",
        '- Import from `./lib/extensy-connectors/supabase.js` or `../lib/extensy-connectors/supabase.js` depending on file location',
        "- Use `createSupabaseConnector()` for sign-up, sign-in, session reads, and table CRUD",
        "- Never place a Supabase service role key in the extension",
        "- If auth is required, build real login and error states around this connector",
      ].join("\n")
    );
  }

  if (connectors.includes("stripe")) {
    sections.push(
      [
        "### Stripe",
        '- Import from `./lib/extensy-connectors/stripe.js` or `../lib/extensy-connectors/stripe.js` depending on file location',
        "- Use `createStripeConnector()` to launch checkout flows",
        "- Never place a Stripe secret key in the extension",
        "- Prefer Stripe Payment Links for zero-backend checkout; otherwise call a backend `STRIPE_CHECKOUT_URL` endpoint",
      ].join("\n")
    );
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Node: initial_router  (START → conditional edge only, no state mutation)
// ---------------------------------------------------------------------------

/**
 * The initial router node doesn't need its own async function because
 * LangGraph evaluates routing conditions synchronously via addConditionalEdges.
 * We use a named function here for clarity in the graph definition below.
 */
function initialRouterFn(
  state: ExtensyState
): "plan_node" | "architect_node" | "coder_node" {
  const log = logger.child({ node: "initial_router", requestId: state.requestId });
  if (state.plan_mode && !state.planApproved) {
    log.info("Routing to plan_node (read-only plan mode)");
    return "plan_node";
  }
  if (state.subscription_tier === "free" || !state.planning_mode) {
    log.info("Routing to coder_node (free tier or planning disabled)");
    return "coder_node";
  }
  log.info("Routing to architect_node");
  return "architect_node";
}

// ---------------------------------------------------------------------------
// Node / Router: plan_node → plan_review_gate
// ---------------------------------------------------------------------------

async function planNode(state: ExtensyState): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "plan_node", requestId: state.requestId });
  publishPhase(state, "plan_node", "Drafting read-only implementation plan...");
  log.info("Generating read-only plan");

  const llm = getArchitectLLM();
  const response = await llm.invoke([
    new SystemMessage(`You are Sidekick's read-only planning agent.
You may inspect requirements and propose architecture, but you must not write files, run shell commands, or modify state outside the returned plan.
Return ONLY JSON matching:
{
  "summary": string,
  "steps": [{ "node": string, "description": string, "files": string[], "estimatedTokens": number }]
}`),
    new HumanMessage(state.user_prompt),
  ]);

  try {
    const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    const parsed = parseJsonPayload<unknown>(raw);
    const validation = validateSchema(SidekickPlanSchema, parsed);
    if (!validation.success) {
      return { error: `plan_node: Invalid plan JSON — ${validation.error}`, status: "blocked" };
    }

    const plan = validation.data as SidekickPlan;
    bus.publish({
      type: "plan.generated",
      requestId: state.requestId,
      summary: plan.summary,
      steps: plan.steps.map((step) => `${step.node}: ${step.description}`),
    });

    return { plan, status: "awaiting_review" };
  } catch (err) {
    return { error: `plan_node: Failed to parse plan — ${String(err)}`, status: "blocked" };
  }
}

function planReviewGateFn(state: ExtensyState): "architect_node" | typeof END {
  if (state.planApproved) return "architect_node";
  return END;
}

// ---------------------------------------------------------------------------
// Node: architect_node
// ---------------------------------------------------------------------------

/**
 * Calls Sonnet to decompose the raw user_prompt into a structured Blueprint.
 * Returns only the fields it updates (LangGraph merges partial state).
 */
async function architectNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "architect_node", requestId: state.requestId });
  publishPhase(state, "architect_node", "Analyzing extension architecture...");
  log.info("Planning extension architecture");

  const llm = getArchitectLLM();

  const systemPrompt = `You are an elite Chrome Extension architect.
Given a user prompt, produce a STRICT JSON object that conforms to this schema:
{
  "name": string,
  "description": string,
  "permissions": string[],
  "host_permissions": string[],
  "features": [{ "id": string, "summary": string, "implementation_hint": string }],
  "design_profile": string, // prefer "Editorial Utility" unless the product explicitly demands another visual direction
  "connectors": ["supabase" | "stripe"], // include only if auth, database, or payments are required
  "raw_requirements": string
}
Respond with ONLY the JSON object — no markdown fences, no prose.`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.user_prompt),
  ]);

  let blueprint: Blueprint;
  try {
    const text =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    const parsed = parseJsonPayload<unknown>(text);
    const validation = validateSchema(BlueprintSchema, parsed);
    if (!validation.success) {
      log.warn("Blueprint schema validation failed — using parsed object as-is", {
        validationError: validation.error,
      });
      blueprint = parsed as Blueprint;
    } else {
      blueprint = validation.data as Blueprint;
    }
    blueprint.raw_requirements = state.user_prompt;
  } catch (err) {
    log.error("Failed to parse blueprint JSON", { error: String(err) });
    return { error: `architect_node: Failed to parse blueprint — ${String(err)}` };
  }

  log.info("Blueprint ready", { name: blueprint.name });
  return { blueprint };
}

// ---------------------------------------------------------------------------
// Node / Router: research_router  (architect → researcher OR coder)
// ---------------------------------------------------------------------------

function researchRouterFn(
  state: ExtensyState
): "researcher_node" | "compaction_node" {
  const log = logger.child({ node: "research_router", requestId: state.requestId });
  if (state.subscription_tier === "max" || state.subscription_tier === "pro") {
    log.info("Routing to researcher_node", { tier: state.subscription_tier });
    return "researcher_node";
  }
  log.info("Routing to coder_node (no research on free tier)");
  return "compaction_node";
}

// ---------------------------------------------------------------------------
// Helper: fetch and strip a documentation web page to plain text
// ---------------------------------------------------------------------------

type FetchDocPageFn = (url: string, maxChars?: number) => Promise<string>;
let fetchDocPageOverrideFn: FetchDocPageFn | null = null;

export function setFetchDocPageForTests(fn: FetchDocPageFn): void {
  fetchDocPageOverrideFn = fn;
}

export function resetFetchDocPageForTests(): void {
  fetchDocPageOverrideFn = null;
}

/**
 * Fetches a public URL, strips all HTML/script/style tags, collapses whitespace,
 * and truncates to `maxChars` to avoid blowing the context window.
 * Uses AbortSignal.timeout so it never hangs the pipeline.
 */
async function fetchDocPage(url: string, maxChars = 3500): Promise<string> {
  if (fetchDocPageOverrideFn) return fetchDocPageOverrideFn(url, maxChars);
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" || !ALLOWED_DOC_HOSTS.has(parsedUrl.hostname)) {
      logger.warn("Blocked unsupported documentation URL", { node: "researcher_node", url });
      return "";
    }

    const res = await fetch(url, {
      signal: AbortSignal.timeout(9000),
      headers: { "User-Agent": "Extensy-Sidekick-Researcher/1.0" },
    });
    if (!res.ok) {
      logger.warn("Doc fetch returned non-OK", { node: "researcher_node", url, status: res.status });
      return "";
    }
    const html = await res.text();
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
    logger.debug("Doc page fetched", { node: "researcher_node", url, chars: stripped.length });
    return `--- Source: ${url} ---\n${stripped}`;
  } catch (err) {
    logger.warn("Doc page fetch failed", { node: "researcher_node", url, error: String(err) });
    return "";
  }
}

// ---------------------------------------------------------------------------
// Node: researcher_node (Pro + Max tier)
// ---------------------------------------------------------------------------

/**
 * Super Researcher — a 5-phase pipeline that deeply understands the extension
 * requirements by decomposing the prompt, fetching real documentation, and
 * combining it with Nia indexed context into a rich research brief.
 *
 * Phase 1 (haiku): Decompose blueprint → specific research questions
 * Phase 2 (haiku): Map questions → authoritative documentation URLs
 * Phase 3 (fetch): Parallel-fetch all URLs, strip to plain text
 * Phase 4 (sonnet + Nia): Semantic recall from Nia indexed repos
 * Phase 5 (sonnet, Max only): Synthesize all into a structured research brief
 *
 * Pro  = Phases 1-4 (raw context chunks)
 * Max  = Phases 1-5 (fully synthesized, structured brief)
 */
async function researcherNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "researcher_node", requestId: state.requestId });
  publishPhase(state, "researcher_node", "Fetching contextual intelligence...");
  log.info("Starting deep research", { tier: state.subscription_tier });
  const ctx = configureNodeContext(state);

  const decomposerLLM  = getDecomposerLLM();   // claude-haiku-4-5 — fast & cheap
  const synthesizerLLM = getArchitectLLM();     // claude-sonnet-4-5 for synthesis

  const blueprintJson = state.blueprint
    ? JSON.stringify(state.blueprint, null, 2)
    : `User prompt: ${state.user_prompt}`;

  const designProfile = state.blueprint?.design_profile || "Editorial Utility";

  // ── Phase 1: Decompose → Research Questions ─────────────────────────────
  log.info("Phase 1 — Decomposing into research questions");

  const p1Response = await decomposerLLM.invoke([
    new SystemMessage(`You are a Chrome Extension hallucination-prevention researcher.
Given a blueprint, output a NUMBERED LIST of 3-5 PRECISE questions whose answers (from official Chrome docs)
would prevent wrong API signatures, invented endpoint URLs, or broken CSP patterns.

Make each question specific enough to be answered by a single reference page.
Good: "What is the exact method signature of chrome.scripting.executeScript() in MV3?"
Bad: "How does Chrome storage work?"

Return ONLY the numbered list, no prose, no headers.`),
    new HumanMessage(`Generate hallucination-prevention research questions for:\n\n${blueprintJson}`),
  ]);

  const researchQuestions = typeof p1Response.content === "string"
    ? p1Response.content
    : JSON.stringify(p1Response.content);
  log.info("Phase 1 complete", { questionCount: researchQuestions.split("\n").length });

  // ── Phase 2: Map Questions → Documentation URLs ──────────────────────────
  log.info("Phase 2 — Mapping questions to documentation URLs");

  const p2Response = await decomposerLLM.invoke([
    new SystemMessage(`You are a Chrome Extension documentation URL resolver.
Map each research question to the single most authoritative documentation URL.
PREFER developer.chrome.com/docs/extensions/reference/api/{name} for Chrome API questions.
For Web APIs use developer.mozilla.org. For third-party APIs use their official docs.
Return ONLY one URL per line — no prose, no numbering, no markdown fences.`),
    new HumanMessage(`Find documentation URLs for these research questions:\n\n${researchQuestions}`),
  ]);

  const urlBlock = typeof p2Response.content === "string"
    ? p2Response.content
    : JSON.stringify(p2Response.content);

  const llmSuggestedUrls = urlBlock
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("http"))
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && ALLOWED_DOC_HOSTS.has(parsed.hostname);
      } catch {
        return false;
      }
    });

  // Deterministically inject Chrome API reference pages for declared permissions.
  // These are always correct and target the exact APIs the coder will use.
  const baselineUrls = (state.blueprint?.permissions ?? [])
    .slice(0, 4)
    .map(p => CHROME_API_DOC_URLS[p])
    .filter((u): u is string => !!u);

  const docUrls = [...new Set([...baselineUrls, ...llmSuggestedUrls])].slice(0, 6);

  log.info("Phase 2 complete", { urlCount: docUrls.length, urls: docUrls });

  // ── Phase 3: Parallel Web Fetch ──────────────────────────────────────────
  log.info("Phase 3 — Fetching documentation pages", { urlCount: docUrls.length });

  const fetchResults = await parallelBatch(
    ctx,
    docUrls.map((url) => ({
      tool: "fetch",
      args: { url },
      run: () => fetchDocPage(url),
    }))
  );

  const webContent = fetchResults
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && r.value.length > 0)
    .map(r => r.value)
    .join("\n\n")
    .slice(0, 12000); // hard cap: 6 pages × 2k chars each keeps synthesis input manageable

  log.info("Phase 3 complete", { webContentLength: webContent.length });

  // ── Phase 4: Nia Semantic Recall (tier-aware depth) ──────────────────────
  const isMax = state.subscription_tier === "max";
  log.info(`Phase 4 — Pulling context from Nia (${isMax ? "deep" : "query"} mode)`);

  let niaContext = "(Nia unavailable for this run)";
  try {
    const niaClient = getNiaClient();
    const niaQueries = buildNiaQueries(state);

    log.info("Phase 4 — Nia queries", { queries: niaQueries, mode: isMax ? "deep+query" : "query" });

    let niaResults: string[];
    if (isMax) {
      // Max tier: searchDeep for the primary (most hallucination-prone) query,
      // searchQuery for the remaining contextual queries in parallel.
      const [deepResult, ...restResults] = await Promise.all([
        niaClient.searchDeep(niaQueries[0]).catch(() => ""),
        ...niaQueries.slice(1).map((q) => niaClient.searchQuery(q).catch(() => "")),
      ]);
      niaResults = [deepResult, ...restResults];
    } else {
      // Pro tier: searchQuery for all queries — multi-source RAG against indexed docs.
      niaResults = await Promise.all(
        niaQueries.map((q) => niaClient.searchQuery(q).catch(() => ""))
      );
    }

    // Cap each result to 1,800 chars so 5 results stay within ~9,000 chars total
    const combined = niaResults
      .map((r) => r.slice(0, 1800))
      .filter(Boolean)
      .join("\n\n---\n\n");

    if (combined.trim()) niaContext = combined;

    log.info("Phase 4 complete", { niaContextLength: niaContext.length, queryCount: niaQueries.length });
  } catch (err) {
    log.warn("Phase 4 skipped — Nia unavailable", { error: String(err) });
  }

  // ── Phase 5: Synthesize (Max-tier only) ──────────────────────────────────
  if (state.subscription_tier !== "max") {
    // Pro tier: prioritise Nia context and web docs, skip full synthesis.
    // Cap to 6,000 chars so the coder prompt stays within budget.
    const rawContext = [
      "## Nia API & Design Context\n" + niaContext.slice(0, 3000),
      "## Web Documentation\n" + webContent.slice(0, 2500),
    ].join("\n\n---\n\n").slice(0, 6000);

    log.info("Phase 5 skipped (Pro tier) — passing raw context", { contextLength: rawContext.length });
    return { research_context: rawContext };
  }

  log.info("Phase 5 — Synthesizing research brief (Max tier)");

  const p5Response = await synthesizerLLM.invoke([
    new SystemMessage(`You are a senior Chrome Extension research analyst.
Synthesize the provided web documentation and Nia context into a COMPACT, actionable grounding brief.

HARD CONSTRAINTS:
- Output MUST be under 4,000 characters total. Cut aggressively.
- Prioritise: real method signatures, real permission names, exact CSS values, real endpoint paths.
- No prose, no explanations, no headers longer than one line.
- Every line must be directly usable by the coder or UI designer. Delete anything decorative.

Structure with these exact sections (keep each section under 800 characters):
## Chrome API Patterns & MV3 Rules
## CSP & Security Constraints
## UI Design Tokens (exact hex/px values only)
## Implementation Gotchas`),
    new HumanMessage(
      `## Research Questions\n${researchQuestions}\n\n` +
      `## Web Documentation Fetched\n${webContent || "(no pages fetched)"}\n\n` +
      `## Nia Design & API Context\n${niaContext}`
    ),
  ]);

  const synthesizedBrief = (typeof p5Response.content === "string"
    ? p5Response.content
    : JSON.stringify(p5Response.content)
  ).slice(0, 5000); // hard cap: keep coder input budget safe

  log.info("Phase 5 complete", { briefLength: synthesizedBrief.length });
  return { research_context: synthesizedBrief };
}

// ---------------------------------------------------------------------------
// Node: compaction_node
// ---------------------------------------------------------------------------

async function compactionNode(state: ExtensyState): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "compaction_node", requestId: state.requestId });
  publishPhase(state, "compaction_node", "Checking context size...");

  const contextText = [
    state.user_prompt,
    state.compacted_context,
    state.blueprint ? JSON.stringify(state.blueprint) : "",
    state.research_context,
    state.devtools_summary,
    state.verify_error,
    ...state.qa_logs.map((entry) => `${entry.type}:${entry.level}:${entry.message}`),
  ]
    .filter(Boolean)
    .join("\n\n");
  const estimatedTokens = Math.ceil(contextText.length / 4);
  const threshold = state.subscription_tier === "max" ? 12000 : 6000;

  if (estimatedTokens < threshold) {
    log.info("Context below compaction threshold", { estimatedTokens, threshold });
    return {};
  }

  const llm = getArchitectLLM();
  const response = await llm.invoke([
    new SystemMessage(
      "Summarize the following development context into a compact brief. Keep all file decisions, blueprint structures, and unresolved errors. Discard pleasantries and old code snippets that have been superseded."
    ),
    new HumanMessage(contextText.slice(-48_000)),
  ]);
  const summary =
    typeof response.content === "string" ? response.content : JSON.stringify(response.content);

  bus.publish({ type: "context.compacted", requestId: state.requestId, summary });
  return {
    compacted_context: summary,
    research_context: state.research_context.slice(-12000),
    devtools_summary: "",
  };
}

// ---------------------------------------------------------------------------
// Node: design_brief_node
// ---------------------------------------------------------------------------

async function designBriefNode(state: ExtensyState): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "design_brief_node", requestId: state.requestId });
  publishPhase(state, "design_brief_node", "Creating structured design brief...");

  if (state.designBrief) return {};

  const llm = getUIDesignerLLM();
  const response = await llm.invoke([
    new SystemMessage(`You are an elite Chrome Extension product designer.
Return ONLY JSON matching:
{
  "designTokens": {
    "colors": { "primary": "", "background": "", "surface": "", "text": "" },
    "borderRadius": "",
    "fontFamily": "",
    "spacingUnit": ""
  },
  "componentHierarchy": [{ "name": "PopupRoot", "children": ["Header", "MainContent", "Footer"] }],
  "layout": "popup",
  "iconSet": "inline-svg",
  "responsive": true,
  "darkMode": "media-query"
}
Use restrained editorial utility styling. Avoid purple-blue AI gradients, emojis, external fonts, and framework-only styling.`),
    new HumanMessage(
      [
        `User request:\n${state.user_prompt}`,
        state.blueprint ? `Blueprint:\n${JSON.stringify(state.blueprint, null, 2)}` : "",
        state.research_context ? `Research context:\n${state.research_context.slice(0, 12000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    ),
  ]);

  try {
    const raw = typeof response.content === "string" ? response.content : JSON.stringify(response.content);
    const parsed = parseJsonPayload<unknown>(raw);
    const validation = validateSchema(DesignBriefSchema, parsed);
    if (!validation.success) {
      log.warn("Design brief validation failed", { validationError: validation.error });
      return {};
    }

    return { designBrief: validation.data as DesignBrief };
  } catch (err) {
    log.warn("Design brief parse failed", { error: String(err) });
    return {};
  }
}


// ---------------------------------------------------------------------------
// Node: coder_node  (OpenCode-style agentic loop)
// ---------------------------------------------------------------------------

/**
 * Extract partial source files from a raw LLM text response.
 * Falls back to regex extraction when full JSON parse fails.
 */
function extractPartialFiles(raw: string): SourceCode {
  const partial: SourceCode = {};
  const filePattern =
    /"([^"]+\.(?:js|ts|html|css|json|md|txt|svg|png))"\s*:\s*"((?:[^"\\]|\\.)*)"/gs;
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(raw)) !== null) {
    const [, filename, content] = match;
    partial[filename] = content
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, '"');
  }
  return partial;
}

/**
 * Parse a raw LLM text response into a SourceCode map.
 * Tries strict JSON parse first, then partial regex extraction.
 */
function parseSourceCodeFromText(raw: string, log: ReturnType<typeof logger.child>): SourceCode | null {
  try {
    const parsed = parseJsonPayload<unknown>(raw);
    const validation = validateSchema(SourceCodeSchema, parsed);
    if (validation.success) return validation.data;
    log.warn("Source code schema validation failed — using raw parse", {
      validationError: validation.error,
    });
    return parsed as SourceCode;
  } catch {
    const partial = extractPartialFiles(raw);
    if (Object.keys(partial).length > 0) {
      log.warn("Partial file extraction from text", { fileCount: Object.keys(partial).length });
      return partial;
    }
    return null;
  }
}

/**
 * Build the coder system prompt.
 *
 * OpenCode reference: packages/opencode/src/session/system.ts
 * The system prompt combines the universal OPENCODE_SYSTEM_DISCIPLINE with
 * Chrome Extension–specific rules and an explicit workflow for the agentic loop.
 */
function buildCoderSystemPrompt(connectors: ConnectorKind[], state: ExtensyState): string {
  const designProfileLine = state.blueprint?.design_profile
    ? `Target design profile: "${state.blueprint.design_profile}".`
    : 'Target design profile: "Editorial Utility".';

  return [
    OPENCODE_SYSTEM_DISCIPLINE,
    "",
    "## Chrome Extension Engineering Rules",
    "- Always include manifest.json with manifest_version: 3.",
    "- Always include a browser-action popup: popup.html + popup.css + popup.js. manifest action.default_popup must point to popup.html.",
    "- Extension popups are raw static files. Never use Tailwind, @tailwind, @apply, CDN imports, build-step CSS, external font imports, or framework syntax.",
    "- Write complete, production CSS by hand. Target 360px wide × 480px tall popup. Use real selectors that exist in the HTML.",
    "- Popup must be a polished product surface: clear title, short description, status area, primary action button (id=\"primary-action\"), status element (aria-label=\"Status\"), disabled/error/empty states, accessible labels.",
    "- Use inline SVG icons with currentColor. Do not use emoji as UI icons.",
    "- Never use eval() or inline scripts (MV3 CSP compliance).",
    "- Service workers must follow MV3 patterns (no persistent background pages).",
    "- All external requests must use host_permissions declared in the manifest.",
    "- Never invent third-party API endpoints, domains, or SDK URLs. External APIs are allowed only when the exact endpoint/domain appears in the user request, connector prompt, or research context.",
    "- For AI features without an explicitly provided endpoint, implement a local deterministic fallback or a settings UI for user-provided keys.",
    designProfileLine,
    connectors.length > 0
      ? "- Wire the provided Extensy connector modules for auth/database/payments. Do not invent raw provider glue."
      : "",
    "- Pristine, highly readable code formatting. Never minify. Correct indentation and newlines throughout.",
    "- When fixing a QA or verification error, preserve unrelated files and make the smallest coherent change.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build the initial user message for the coder agent.
 * On QA retries, includes the error log so the agent can self-heal.
 */
function buildCoderUserMessage(
  state: ExtensyState,
  connectors: ConnectorKind[],
  isRetry: boolean
): string {
  const parts: string[] = [];

  if (state.blueprint) {
    parts.push(
      `## Extension Blueprint\n\`\`\`json\n${JSON.stringify(state.blueprint, null, 2)}\n\`\`\``
    );
  } else {
    parts.push(`## User Request\n${state.user_prompt}`);
  }

  if (state.research_context) {
    parts.push(
      `## Relevant Documentation (from Nia context)\n${state.research_context.slice(0, 5000)}`
    );
  }

  if (state.compacted_context) {
    parts.push(`## Compacted Development Context\n${state.compacted_context}`);
  }

  if (state.designBrief) {
    parts.push(
      `## Structured Design Brief\n\`\`\`json\n${JSON.stringify(state.designBrief, null, 2)}\n\`\`\`\nAll generated UI must follow these tokens and component hierarchy exactly.`
    );
  }

  if (connectors.length > 0) {
    parts.push(buildConnectorPrompt(connectors));
  }

  if (state.verify_error) {
    parts.push(
      `## Static Verification Error — Fix Before Browser QA (attempt ${state.verify_retry_count + 1}/2)\n${state.verify_error}`
    );
  }

  if (isRetry) {
    const errorSummary = state.qa_logs
      .map((l) => `[${l.type}/${l.level}] ${l.message}`)
      .join("\n");
    let retryContext = `## QA Errors — Fix These (attempt ${state.qa_retry_count + 1}/${MAX_QA_RETRIES})\n${errorSummary}`;
    if (state.devtools_summary) {
      retryContext += `\n\n## Deep Browser Diagnostics (DevTools MCP)\n${state.devtools_summary}`;
    }
    retryContext +=
      "\n\nUse read_file to inspect the current file, then edit_file for a surgical fix. Preserve all unrelated code.";
    parts.push(retryContext);
  }

  return parts.join("\n\n");
}

/**
 * The heart of the pipeline — OpenCode-style agentic coder loop.
 *
 * OpenCode reference:
 *   packages/opencode/src/session/prompt.ts  (loop function, tool execution)
 *   packages/opencode/src/tool/registry.ts   (BashTool, ReadTool, WriteTool, EditTool)
 *
 * Replaces the previous single-shot LLM call with an iterative tool-calling loop:
 *   1. LLM receives tools: write_file / edit_file / read_file / list_files / bash_check
 *   2. LLM writes extension files one-by-one (or in parallel batches)
 *   3. After verifying with bash_check, LLM outputs a completion signal (text, no tool calls)
 *   4. On the last step (isLastStep), tools are removed — LLM falls back to JSON output
 *   5. Workspace (SourceCode map) accumulates across all steps; text JSON fills any gaps
 *
 * On QA-triggered re-runs (isRetry), the workspace is pre-seeded from state.source_code
 * so the LLM can use edit_file for surgical fixes rather than rewriting everything.
 */
async function coderNode(state: ExtensyState): Promise<Partial<ExtensyState>> {
  const isRetry = state.qa_logs.length > 0 || state.devtools_summary.length > 0;
  const connectors = detectRequiredConnectors(state);
  const log = logger.child({ node: "coder_node", requestId: state.requestId });
  const maxSteps = MAX_AGENT_STEPS[state.subscription_tier] ?? 3;

  publishPhase(state, "coder_node", "Writing extension code...");
  log.info("Agentic coder started", {
    isRetry,
    attempt: state.qa_retry_count + 1,
    connectors,
    maxSteps,
    tier: state.subscription_tier,
  });

  // ── Free-tier Nia grounding (inject before the loop, same as before) ───────
  const stateParts: string[] = [];
  if (state.subscription_tier === "free" && !state.research_context && !isRetry) {
    try {
      const primaryPerm = state.blueprint?.permissions?.[0];
      const niaQuery = primaryPerm
        ? `Chrome Extension MV3 chrome.${primaryPerm} API method signatures parameters code examples`
        : "Chrome Extension MV3 activeTab scripting executeScript API patterns content scripts";
      const niaClient = getNiaClient();
      const webGrounding = await niaClient.searchWeb(niaQuery, 3);
      if (webGrounding.trim()) {
        stateParts.push(`## Chrome API Quick Reference (Nia)\n${webGrounding.slice(0, 600)}`);
        log.info("Free-tier Nia grounding injected", { chars: Math.min(webGrounding.length, 600) });
      }
    } catch (err) {
      log.warn("Free-tier Nia grounding skipped", { error: String(err) });
    }
  }

  const llm = getCoderLLM(state.subscription_tier);
  const ctx = configureNodeContext(state);
  const systemPromptText = buildCoderSystemPrompt(connectors, state);
  const initialUserContent = [
    buildCoderUserMessage(state, connectors, isRetry),
    ...stateParts,
  ].join("\n\n");

  // On retries, pre-seed the workspace so the agent can read/edit existing files
  const workspace: SourceCode = isRetry ? { ...state.source_code } : {};

  const messages: ApiMessage[] = [
    { role: "system", content: systemPromptText },
    { role: "user", content: initialUserContent },
  ];

  // ── OpenCode-style agentic loop ────────────────────────────────────────────
  for (let step = 0; step < maxSteps; step++) {
    const isLastStep = step === maxSteps - 1;
    const tools = isLastStep ? [] : CODER_TOOLS;

    publishPhase(
      state,
      "coder_node",
      `Agentic step ${step + 1}/${maxSteps}${isLastStep ? " (final)" : ""}...`
    );
    log.info("Agentic loop step", { step: step + 1, maxSteps, isLastStep, hasTools: tools.length > 0 });

    let turn;
    try {
      turn = await llm.invokeWithTools(messages, tools);
    } catch (err) {
      log.error("LLM turn failed", { step: step + 1, error: String(err) });
      return { error: `coder_node: LLM error at step ${step + 1} — ${String(err)}` };
    }

    if (turn.rawToolCalls.length > 0 && !isLastStep) {
      // ── Tool-calling turn: execute tools, accumulate messages ──────────────
      messages.push({
        role: "assistant",
        content: turn.content,
        tool_calls: turn.rawToolCalls,
      });

      // Execute all tool calls in parallel (OpenCode pattern — independent writes/checks run concurrently)
      const toolResults = await Promise.all(
        turn.rawToolCalls.map(async (toolCall) => {
          let parsedArgs: unknown;
          try {
            parsedArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            parsedArgs = {};
          }
          const result = await executeAgentTool(
            toolCall.function.name,
            parsedArgs,
            workspace,
            ctx,
            TMP_EXT_DIR
          );
          return { toolCall, result };
        })
      );

      for (const { toolCall, result } of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result.output,
        });
        log.info("Tool executed", {
          step: step + 1,
          tool: toolCall.function.name,
          isError: result.isError,
          outputPreview: result.output.slice(0, 120),
        });
      }

      // Synthetic recovery message when any tool fails (OpenCode error-recovery pattern)
      const toolErrors = toolResults.filter(({ result }) => result.isError);
      if (toolErrors.length > 0) {
        const summary = toolErrors
          .map(({ toolCall, result }) => `'${toolCall.function.name}': ${result.output}`)
          .join("\n");
        messages.push({
          role: "user",
          content: `The following tool calls failed — fix and retry:\n${summary}`,
        });
      }

      // Publish live workspace size so the frontend can show progress
      const workspaceFileCount = Object.keys(workspace).length;
      if (workspaceFileCount > 0) {
        bus.publish({
          type: "phase.started",
          requestId: state.requestId,
          node: "coder_node",
          message: `Workspace: ${workspaceFileCount} file${workspaceFileCount !== 1 ? "s" : ""} written`,
        });
      }

      continue;
    }

    // ── Text response turn: extract source code ────────────────────────────
    const textContent = turn.content ?? "";

    // If the agent wrote files via tools, the workspace is the source of truth.
    // Text output may also contain a JSON backup — merge with workspace winning.
    if (textContent) {
      const fromText = parseSourceCodeFromText(textContent, log);
      if (fromText) {
        // Workspace files override text-parsed files (they are more up-to-date)
        Object.assign(workspace, { ...fromText, ...workspace });
      }
    }

    log.info("Agent loop complete", {
      step: step + 1,
      workspaceFiles: Object.keys(workspace).length,
      finishReason: turn.finishReason,
    });
    break;
  }

  // ── Validate workspace ────────────────────────────────────────────────────
  if (Object.keys(workspace).length === 0) {
    log.error("Agent loop produced no source files");
    return { error: "coder_node: Agent loop exhausted without producing any source files" };
  }

  // Normalise JSON files that may have been written with unformatted content
  for (const [filename, content] of Object.entries(workspace)) {
    if (filename.endsWith(".json")) {
      try {
        workspace[filename] = JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // leave as-is if the generated JSON is invalid — verifyNode will catch it
      }
    }
  }

  log.info("Code generation complete", {
    fileCount: Object.keys(workspace).length,
    files: Object.keys(workspace),
  });

  const connectorFiles = buildConnectorFiles(connectors);
  const withConnectorFiles = { ...workspace, ...connectorFiles };

  const ungroundedEndpoints = findUngroundedExternalEndpoints(withConnectorFiles, state);
  if (ungroundedEndpoints.length > 0) {
    log.error("Generated ungrounded external endpoints", { endpoints: ungroundedEndpoints });
    return {
      error:
        "coder_node: Generated ungrounded external endpoint(s): " +
        ungroundedEndpoints.join(", ") +
        ". Only use endpoints explicitly present in the user prompt, connector prompt, or Nia/research context.",
    };
  }

  const patchedSourceCode = normalizeGeneratedManifest(
    patchManifestForConnectors(withConnectorFiles, connectors)
  );
  const polishedSourceCode = ensurePremiumPopup(patchedSourceCode, state);
  const fileVersions = Object.fromEntries(
    Object.keys(polishedSourceCode).map((filePath) => [
      filePath,
      (state.fileVersions[filePath] ?? 0) + 1,
    ])
  );

  return {
    source_code: polishedSourceCode,
    fileVersions,
    verify_error: "",
    qa_logs: [],
    qa_retry_count: state.qa_retry_count + (isRetry ? 1 : 0),
  };
}

// ---------------------------------------------------------------------------
// Node: ui_designer_node
// ---------------------------------------------------------------------------

/**
 * Scans the generated source_code for HTML, CSS, and UI-related files,
 * then enhances their design to ensure a stunning, modern, and vibrant
 * appearance using best practices in web design (e.g., dynamic animations,
 * beautiful typography, and responsive layouts).
 */
async function uiDesignerNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "ui_designer_node", requestId: state.requestId });
  publishPhase(state, "ui_designer_node", "Polishing extension UI...");
  log.info("Enhancing extension UI/UX design");

  const llm = getUIDesignerLLM();

  const codeSnapshot = Object.entries(state.source_code)
    .filter(([filePath]) => filePath.endsWith(".html") || filePath.endsWith(".css") || filePath.endsWith(".js"))
    .map(([file, content]) => `// === ${file} ===\n${content}`)
    .join("\n\n");

  const systemPrompt = `You are an elite Chrome Extension UI designer.
Your task is to completely eliminate generic 'vibecoded' UI and apply a highly structured, premium aesthetic based on the provided design profile and research context.

Strict Design Rules:
1. DESIGN PROFILE: You must strictly apply the "${state.blueprint?.design_profile || 'Editorial Utility'}" design profile.
2. RESEARCH CONTEXT: Use relevant color codes, spacing, and border radii from the Nia Design Inspiration context below, but translate them into plain CSS. Do not use Tailwind or utility classes.
3. EDITORIAL UTILITY DIRECTION: Use a warm off-white canvas (light) or deep charcoal canvas (dark), deep ink text, one restrained accent, left-aligned hierarchy, mono metadata labels, and asymmetrical composition. Avoid SaaS dashboard tropes, glow effects, centered hero blocks, and card spam.
4. COLOR DISCIPLINE — ABSOLUTE BAN: NEVER use #FF00FF, #00FFFF, neon green, electric violet, hot pink, bright indigo (#4B5BFF or similar), cyan (#22D3EE or similar), or any saturated HSL color with lightness above 70% on a dark background. These colors look amateur and AI-generated. Instead use: warm neutrals (copper, stone, parchment), muted earth tones, cool graphite, or a single restrained accent that could appear in editorial print design. The "Editorial Utility" palette is the gold standard: warm off-white canvas, deep ink, one accent (e.g. teal #0f766e, copper #D4A574, sage #6B7E70, slate #4A6572). Adapt the accent to the extension's purpose — security tools get cooler slate-blues, media tools get warmer ambers, productivity tools get warm copper or sage.
5. NO PURPLE/BLUE AI GRADIENTS: Never produce gradients from purple to blue, violet to pink, cyan to indigo, or any combination that reads as "AI brand aesthetic." A single-color gradient (light to dark of the same hue) is acceptable if subtle.
6. FOUNDATION: Use system UI font stacks so the popup is self-contained. Use high-quality inline SVGs configured with \`currentColor\`; do not use emojis for icons.
7. MICRO-INTERACTIONS: Keep motion minimal and tactile with raw CSS transitions and \`:active\` transforms. Do not write framework-only animation tokens.
8. SPACING: Use a strict 4-point spacing scale and strong whitespace rhythm. Not every section should be boxed.
9. CHROME EXTENSION CONSTRAINTS: Popup UI must be raw static HTML, CSS, and JS. Never use \`@tailwind\`, \`@apply\`, utility-class soup, CDN imports, external font imports, React/Vue/Svelte syntax, TypeScript-only syntax, or build-step CSS.
10. FILE BOUNDARY: Edit only existing popup/options/sidepanel/content HTML, CSS, and JS files. Do not return \`manifest.json\`, background workers, connector libraries, package files, or unrelated app files.
11. STRUCTURED BRIEF: If a design brief is provided, obey its tokens, hierarchy, layout, icon set, responsiveness, and dark-mode strategy exactly.

Return ONLY a JSON object where each key is a relative file path (same as provided) and each value is the strictly formatted stringified file content.
Example: { "popup.html": "...", "popup.css": "..." }
Do not remove functionality or data bindings. Only ENHANCE the styles and structure.
Output ONLY the JSON map — no markdown fences, no prose.`;

  const userMessageContent = state.research_context
    ? `Structured Design Brief:\n${JSON.stringify(state.designBrief, null, 2)}\n\nNia Design Inspiration Context:\n${state.research_context.slice(0, 3000)}\n\nEnhance the UI of the following extension code:\n\n${codeSnapshot}`
    : `Structured Design Brief:\n${JSON.stringify(state.designBrief, null, 2)}\n\nEnhance the UI of the following extension code:\n\n${codeSnapshot}`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userMessageContent),
  ]);

  const raw =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  let uiFiles: SourceCode = {};
  try {
    const cleaned = extractJsonPayload(raw);
    if (cleaned !== "{}") {
      uiFiles = JSON.parse(cleaned) as SourceCode;
    }
  } catch (err) {
    log.warn("Could not parse UI designer output — attempting partial extraction", { error: String(err) });
    const partialFiles: SourceCode = {};
    const filePattern = /"([^"]+\.(?:js|ts|html|css|json|md|txt|svg|png))"\s*:\s*"((?:[^"\\]|\\.)*)"/gs;
    let match: RegExpExecArray | null;
    while ((match = filePattern.exec(raw)) !== null) {
      const [, filename, content] = match;
      partialFiles[filename] = content
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\\\/g, "\\")
        .replace(/\\"/g, '"');
    }
    if (Object.keys(partialFiles).length > 0) {
      uiFiles = partialFiles;
    }
  }

  const filteredUiFiles = filterUIDesignerFiles(uiFiles, state.source_code);

  log.info("UI enhancement complete", {
    fileCount: Object.keys(filteredUiFiles).length,
    files: Object.keys(filteredUiFiles),
  });

  return {
    source_code: ensurePremiumPopup(
      normalizeGeneratedManifest({ ...state.source_code, ...filteredUiFiles }),
      state
    ),
  };
}

// ---------------------------------------------------------------------------
// Router: ui_designer_router
// ---------------------------------------------------------------------------

function uiDesignerRouterFn(
  _state: ExtensyState
): "ui_designer_node" | "verify_node" {
  // UI designer runs for all tiers.
  return "ui_designer_node";
}

// ---------------------------------------------------------------------------
// Node / Router: verify_node
// ---------------------------------------------------------------------------

async function verifyNode(state: ExtensyState): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "verify_node", requestId: state.requestId });
  publishPhase(state, "verify_node", "Running static verification...");

  const ctx = configureNodeContext(state);
  const permission = evaluatePermission(ctx, "shell", ["static verification"]);
  if (permission === "deny") {
    bus.publish({
      type: "verify.skipped",
      requestId: state.requestId,
      reason: "Shell execution is denied for this tier.",
    });
    return { verify_error: "" };
  }

  await writeExtensionToDisk(ctx, state.source_code);

  const packageJson = state.source_code["package.json"];
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const commands: Array<[string, string[]]> = [["npm", ["install"]]];
      if (scripts.lint) commands.push(["npm", ["run", "lint"]]);
      if (scripts.typecheck) commands.push(["npm", ["run", "typecheck"]]);
      if (scripts.build && !scripts.typecheck) commands.push(["npm", ["run", "build"]]);

      for (const [command, args] of commands) {
        const result = await runCommand(ctx, command, args, { cwd: TMP_EXT_DIR, timeoutMs: 180_000 });
        if (result.code !== 0) {
          const error = `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`.trim();
          bus.publish({
            type: "verify.failed",
            requestId: state.requestId,
            error,
            retryCount: state.verify_retry_count + 1,
          });
          return { verify_error: error, verify_retry_count: state.verify_retry_count + 1 };
        }
      }
    } catch (err) {
      const error = `verify_node: ${String(err)}`;
      bus.publish({
        type: "verify.failed",
        requestId: state.requestId,
        error,
        retryCount: state.verify_retry_count + 1,
      });
      return { verify_error: error, verify_retry_count: state.verify_retry_count + 1 };
    }
  } else {
    const jsFiles = Object.keys(state.source_code).filter((filePath) => filePath.endsWith(".js"));
    const results = await parallelBatch(
      ctx,
      jsFiles.map((filePath) => ({
        tool: "node --check",
        args: { filePath },
        run: () => runCommand(ctx, "node", ["--check", path.join(TMP_EXT_DIR, filePath)], { cwd: TMP_EXT_DIR }),
      })),
      4
    );
    const failures = results
      .filter((result): result is PromiseFulfilledResult<{ code: number; stdout: string; stderr: string }> =>
        result.status === "fulfilled" && result.value.code !== 0
      )
      .map((result) => `${result.value.stdout}\n${result.value.stderr}`.trim())
      .filter(Boolean);

    if (failures.length > 0) {
      const error = failures.join("\n\n");
      bus.publish({
        type: "verify.failed",
        requestId: state.requestId,
        error,
        retryCount: state.verify_retry_count + 1,
      });
      return { verify_error: error, verify_retry_count: state.verify_retry_count + 1 };
    }
  }

  log.info("Static verification passed");
  return { verify_error: "" };
}

function verifyRouterFn(state: ExtensyState): "compaction_node" | "qa_node" {
  if (state.verify_error && state.verify_retry_count < 2) return "compaction_node";
  return "qa_node";
}

// ---------------------------------------------------------------------------
// Node: qa_node
// ---------------------------------------------------------------------------

/**
 * Playwright QA Harness
 *
 * 1. Writes all source_code files to ./tmp/extension/
 * 2. Launches Chromium in headless mode with the extension loaded
 * 3. Navigates to the extension's popup (if present) or a test page
 * 4. Captures console messages and page errors for 5 seconds
 * 5. Returns any captured events as qa_logs
 *
 * Sandbox note: --no-sandbox and --disable-setuid-sandbox are required when
 * running inside CI/Docker containers.  Safe to include on macOS too.
 */
async function qaNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "qa_node", requestId: state.requestId });
  publishPhase(state, "qa_node", "Running browser QA...");

  if (state.subscription_tier === "free") {
    log.info("Skipping QA for free tier");
    return { qa_logs: [] };
  }

  log.info("Writing extension to disk and launching Playwright");

  const ctx = configureNodeContext(state);
  await writeExtensionToDisk(ctx, state.source_code);

  const logs: QALogEntry[] = [];

  // ── Resolve Chromium based on runtime environment ─────────────────────────
  // On Vercel (VERCEL=1) the local Playwright binary is absent; we use
  // @sparticuz/chromium which bundles a serverless-optimised Chromium build.
  const isVercel = process.env.VERCEL === "1";

  let context;
  const userDataDir = path.join(os.tmpdir(), "sidekick", "chromium-profile", crypto.randomUUID());
  const debugPort = await getAvailablePort();
  const popupUrl = resolveExtensionPopupUrl(state.source_code);
  const extensionArgs = [
    `--disable-extensions-except=${TMP_EXT_DIR}`,
    `--load-extension=${TMP_EXT_DIR}`,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
  ];

  try {
    if (isVercel) {
      const executablePath = await sparticuzChromium.executablePath();
      context = await launchPersistentContext(ctx, playwrightChromium, userDataDir, {
        headless: true,
        executablePath,
        args: [...sparticuzChromium.args, ...extensionArgs],
        ignoreDefaultArgs: ["--disable-extensions"],
        timeout: 45_000,
      });
    } else {
      context = await launchPersistentContext(ctx, playwrightChromium, userDataDir, {
        headless: true,
        args: extensionArgs,
        ignoreDefaultArgs: ["--disable-extensions"],
        timeout: 45_000,
      });
    }

    const extensionId = await resolveExtensionId(context);
    const page = await context.newPage();

    // ── Capture console messages ────────────────────────────────────────────
    page.on("console", (msg) => {
      if (["warning", "error"].includes(msg.type())) {
        logs.push({
          type: "console",
          level: msg.type(),
          message: msg.text(),
          captured_at: new Date().toISOString(),
        });
      }
    });

    // ── Capture uncaught page errors ────────────────────────────────────────
    page.on("pageerror", (err) => {
      logs.push({
        type: "pageerror",
        level: "error",
        message: err.message,
        captured_at: new Date().toISOString(),
      });
    });

    const targetUrl = popupUrl
      ? `chrome-extension://${extensionId}/${popupUrl}`
      : "about:blank";

    await page.goto(targetUrl, { waitUntil: "load" });
    await page.waitForTimeout(2000);

    // ── DevTools MCP Diagnostics ────────────────────────────────────────────
    log.info("Running Chrome DevTools MCP diagnostics");
    const diagnostics = await runDevToolsDiagnostics(targetUrl, debugPort, 15000, state.requestId);

    if (diagnostics.consoleLogs.length > 0)   logs.push(...diagnostics.consoleLogs);
    if (diagnostics.networkErrors.length > 0)  logs.push(...diagnostics.networkErrors);
    if (diagnostics.domIssues.length > 0)      logs.push(...diagnostics.domIssues);

    logs.forEach((entry) => {
      bus.publish({
        type: "qa.diagnostic",
        requestId: state.requestId,
        severity: entry.level === "error" ? "error" : entry.level === "warning" ? "warn" : "info",
        message: entry.message,
      });
    });

    const devtools_summary = diagnostics.rawSummary;

    await context.close();
    await rm(ctx, userDataDir).catch((cleanupErr) => {
      log.warn("Failed to remove Chromium user data dir", {
        path: userDataDir,
        error: String(cleanupErr),
      });
    });

    log.info("QA complete", { issueCount: logs.length });
    return { qa_logs: logs, devtools_summary };
  } catch (err) {
    log.error("Playwright launch failed", { error: String(err) });
    logs.push({
      type: "pageerror",
      level: "error",
      message: `Playwright failed to launch: ${String(err)}`,
      captured_at: new Date().toISOString(),
    });
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
    await rm(configureNodeContext(state), userDataDir).catch((cleanupErr) => {
      log.warn("Failed to remove Chromium user data dir in finally", {
        path: userDataDir,
        error: String(cleanupErr),
      });
    });
  }

  return { qa_logs: logs };
}

function resolveExtensionPopupUrl(sourceCode: SourceCode): string | null {
  const manifestSource = sourceCode["manifest.json"];
  if (!manifestSource) return null;

  try {
    const manifest = JSON.parse(manifestSource) as {
      action?: { default_popup?: string };
    };
    return manifest.action?.default_popup?.replace(/^\/+/, "") ?? null;
  } catch {
    return null;
  }
}

async function resolveExtensionId(
  context: Awaited<ReturnType<typeof playwrightChromium.launchPersistentContext>>
): Promise<string> {
  const existingWorker = context.serviceWorkers()[0];
  const serviceWorker =
    existingWorker ?? await context.waitForEvent("serviceworker", { timeout: 15_000 });
  return new URL(serviceWorker.url()).host;
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a debug port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Router: qa_router
// ---------------------------------------------------------------------------

function qaRouterFn(
  state: ExtensyState
): "compaction_node" | "fan_out_router" {
  const log = logger.child({ node: "qa_router", requestId: state.requestId });

  if (state.error) {
    log.warn("Fatal error in state — routing to fan_out_router");
    return "fan_out_router";
  }

  if (state.qa_logs.length > 0 && state.qa_retry_count < MAX_QA_RETRIES) {
    log.info("QA issues found — retrying coder_node", {
      issueCount: state.qa_logs.length,
      retry: `${state.qa_retry_count + 1}/${MAX_QA_RETRIES}`,
    });
    return "compaction_node";
  }

  if (state.qa_logs.length > 0 && state.qa_retry_count >= MAX_QA_RETRIES) {
    log.warn("Max QA retries exhausted — proceeding to assembly", {
      unresolvedIssues: state.qa_logs.length,
      maxRetries: MAX_QA_RETRIES,
    });
    return "fan_out_router";
  }

  log.info("QA passed — routing to fan_out_router");
  return "fan_out_router";
}

// ---------------------------------------------------------------------------
// Router: fan_out_router
// ---------------------------------------------------------------------------

function fanOutRouterFn(state: ExtensyState): string[] | string {
  const log = logger.child({ node: "fan_out_router", requestId: state.requestId });

  if (state.error) return END;

  switch (state.subscription_tier) {
    case "free":
      log.info("Routing to assembler_node (free tier)");
      return "assembler_node";

    case "pro":
      log.info("Routing to legal_node (pro tier)");
      return "legal_node";

    case "max":
      log.info("Routing to [legal_node, integration_node] in parallel (max tier)");
      return ["legal_node", "integration_node"];

    default:
      return "assembler_node";
  }
}

// ---------------------------------------------------------------------------
// Node: legal_node
// ---------------------------------------------------------------------------

/**
 * Generates Terms of Service + Privacy Policy documents tailored to the extension,
 * uploads them to Supabase Storage, and returns public URLs.
 */
async function legalNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "legal_node", requestId: state.requestId });
  publishPhase(state, "legal_node", "Generating legal documents...");
  log.info("Generating legal documents");

  const llm = getLegalLLM(); // Haiku — cost-efficient for doc generation

  const blueprint = state.blueprint;
  const extensionName = blueprint?.name ?? "This Extension";
  let cleanAuthor = toKebabCase(state.author);
  if (!cleanAuthor) cleanAuthor = "user";
  const docId = state.tos_id || crypto.randomUUID();

  const tosPrompt = `You are a legal document specialist.
Generate a concise but complete Terms of Service for a Chrome Extension.
Include: acceptance clause, data handling, limitation of liability, GDPR notice (if applicable), and contact information placeholder.
Use plain English. Return plain text only (no markdown).`;

  const privacyPrompt = `You are a legal document specialist.
Generate a concise but complete Privacy Policy for a Chrome Extension.
Include: what data is collected, how it is used, storage/retention, third-party processors, user rights, and contact information placeholder.
Use plain English. Return plain text only (no markdown).`;

  const tosResponse = await llm.invoke([
    new SystemMessage(tosPrompt),
    new HumanMessage(
      `Extension name: ${extensionName}\nDescription: ${blueprint?.description ?? state.user_prompt}`
    ),
  ]);

  const privacyResponse = await llm.invoke([
    new SystemMessage(privacyPrompt),
    new HumanMessage(
      `Extension name: ${extensionName}\nDescription: ${blueprint?.description ?? state.user_prompt}\nPermissions: ${(blueprint?.permissions ?? []).join(", ")}\nHosts: ${(blueprint?.host_permissions ?? []).join(", ")}`
    ),
  ]);

  const tosContent =
    typeof tosResponse.content === "string"
      ? tosResponse.content
      : JSON.stringify(tosResponse.content);
  const privacyContent =
    typeof privacyResponse.content === "string"
      ? privacyResponse.content
      : JSON.stringify(privacyResponse.content);

  // ── Upload legal docs to Supabase Storage ────────────────────────────────
  let legalUrl = "";
  let privacyUrl = "";
  const termsHtml = renderLegalDocumentHtml({
    title: "Terms of Service",
    appName: extensionName,
    author: cleanAuthor,
    body: tosContent,
  });
  const privacyHtml = renderLegalDocumentHtml({
    title: "Privacy Policy",
    appName: extensionName,
    author: cleanAuthor,
    body: privacyContent,
  });

  try {
    const supabase = getSupabaseClient();
    legalUrl = await uploadLegalDocument({
      supabase,
      author: cleanAuthor,
      docId,
      kind: "terms-of-service",
      content: termsHtml,
      contentType: "text/html",
    });
    privacyUrl = await uploadLegalDocument({
      supabase,
      author: cleanAuthor,
      docId,
      kind: "privacy-policy",
      content: privacyHtml,
      contentType: "text/html",
    });
  } catch (err) {
    log.error("Supabase upload failed — falling back to data URIs", { error: String(err) });
    legalUrl = `data:text/html;base64,${Buffer.from(termsHtml).toString("base64")}`;
    privacyUrl = `data:text/html;base64,${Buffer.from(privacyHtml).toString("base64")}`;
  }

  log.info("Legal documents ready", {
    hasTerms: !!legalUrl,
    hasPrivacy: !!privacyUrl,
  });
  return {
    legal_url: legalUrl,
    privacy_url: privacyUrl,
  };
}

// ---------------------------------------------------------------------------
// Node: integration_node (Max tier only)
// ---------------------------------------------------------------------------

/**
 * Scans the generated source_code for third-party API calls and generates
 * any required integration glue code (auth helpers, rate-limit wrappers, etc.).
 */
async function integrationNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "integration_node", requestId: state.requestId });
  publishPhase(state, "integration_node", "Auditing integrations...");
  log.info("Auditing and wiring third-party integrations");

  const connectors = detectRequiredConnectors(state);
  const connectorFiles = buildConnectorFiles(connectors);
  const llm = getCoderLLM("max"); // Sonnet for integration quality

  const sourceCode = patchManifestForConnectors(
    {
      ...state.source_code,
      ...connectorFiles,
    },
    connectors
  );

  const codeSnapshot = Object.entries(sourceCode)
    .map(([file, content]) => `// === ${file} ===\n${content}`)
    .join("\n\n");

  const systemPrompt = `You are a senior integration engineer for Chrome Extensions.
Review the provided source code.  If any third-party APIs are called:
1. Generate thin, well-typed helper modules (e.g. api/client.js)
2. Add any missing error-handling wrappers
3. If auth/database/payments are required, wire the existing Extensy connector modules instead of inventing new provider clients
4. Return a JSON map of NEW OR MODIFIED files only (same schema as coder_node output)
If no integrations are needed, return an empty JSON object: {}`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `${buildConnectorPrompt(connectors)}\n\nReview and improve integrations in the following extension code:\n\n${codeSnapshot}`
    ),
  ]);

  const raw =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  let integrationFiles: SourceCode = {};
  try {
    const cleaned = extractJsonPayload(raw);
    if (cleaned !== "{}") {
      integrationFiles = JSON.parse(cleaned) as SourceCode;
    }
  } catch (err) {
    log.warn("Could not parse integration output", { error: String(err) });
  }

  log.info("Integration complete", {
    modifiedFileCount: Object.keys(integrationFiles).length,
    files: Object.keys(integrationFiles),
  });

  // Merge integration files into existing source_code.
  return {
    source_code: patchManifestForConnectors(
      { ...sourceCode, ...integrationFiles },
      connectors
    ),
  };
}

// ---------------------------------------------------------------------------
// Node: assembler_node
// ---------------------------------------------------------------------------

/**
 * Collects all source files and zips them into a distributable archive.
 * Also injects publishing metadata and legal URLs for downstream Extensy flows.
 */
async function assemblerNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  const log = logger.child({ node: "assembler_node", requestId: state.requestId });
  publishPhase(state, "assembler_node", "Packaging extension artifact...");
  log.info("Assembling final Chrome Extension ZIP");

  const zip = new JSZip();
  const promoBrief = buildPromoBrief(state);
  const publishingBrief = buildPublishingBrief(state);
  const sourceCode: SourceCode = {
    ...state.source_code,
    "EXTENSY_PROMO_BRIEF.json": JSON.stringify(promoBrief, null, 2),
    "EXTENSY_CHROME_WEB_STORE.json": JSON.stringify(publishingBrief, null, 2),
  };

  for (const [filePath, content] of Object.entries(sourceCode)) {
    zip.file(filePath, content);
  }

  // Inject legal URLs into the build output for publishing workflows.
  if (state.legal_url || state.privacy_url) {
    zip.file(
      "LEGAL.txt",
      [
        `Terms of Service: ${state.legal_url || "N/A"}`,
        `Privacy Policy: ${state.privacy_url || "N/A"}`,
        "",
        "This extension was generated by Extensy (https://extensy.app).",
      ].join("\n")
    );
  }

  const extensionName =
    state.blueprint?.name?.replace(/\s+/g, "_") ?? "extension";
  const timestamp = Date.now();

  // On Vercel the filesystem outside /tmp is read-only and short-lived,
  // so we skip the disk write. The ZIP bytes are generated in-memory only.
  // Extensy reads source_code via the `files` SSE event — artifact_path
  // is only used for local dev logging.
  const isVercel = process.env.VERCEL === "1";
  let artifactPath = `in-memory:${extensionName}_${timestamp}.zip`;

  if (!isVercel) {
    try {
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      artifactPath = path.join(OUTPUT_DIR, `${extensionName}_${timestamp}.zip`);
      if (state.subscription_tier === "free") {
        artifactPath = `in-memory:${extensionName}_${timestamp}.zip`;
      } else {
        const ctx = configureNodeContext(state);
        await mkdir(ctx, OUTPUT_DIR);
        await writeTextFile(ctx, artifactPath, zipBuffer);
      }
      log.info("Extension ZIP written to disk", { path: artifactPath });
    } catch (err) {
      log.warn("ZIP write failed (non-fatal)", { error: String(err) });
    }
  } else {
    log.info("Extension ready (Vercel — in-memory only)", { name: extensionName });
  }

  bus.publish({ type: "complete", requestId: state.requestId, artifactPath });

  return {
    artifact_path: artifactPath,
    source_code: sourceCode,
    promo_brief: promoBrief,
    publishing_brief: publishingBrief,
    status: "complete",
  };
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * Builds and compiles the Extensy LangGraph state machine.
 *
 * Node naming convention: snake_case matching the constant above.
 * Edge naming convention: *_node for computation nodes, *_router for
 * conditional branching functions (not nodes themselves).
 */
function buildGraph() {
  const graph = new StateGraph(StateAnnotation);

  // ── Register all nodes ────────────────────────────────────────────────────
  // All nodes must be registered before any edges are wired.
  // LangGraph widens its internal node-name generic via chaining; however,
  // TypeScript cannot reflect that widening onto a `const graph` variable.
  // We therefore keep a typed reference only for `.compile()` and use
  // `(graph as any)` for all addEdge / addConditionalEdges calls — this is
  // the official LangGraph recommendation for complex multi-node graphs.
  graph.addNode("plan_node", planNode);
  graph.addNode("architect_node", architectNode);
  graph.addNode("researcher_node", researcherNode);
  graph.addNode("compaction_node", compactionNode);
  graph.addNode("design_brief_node", designBriefNode);
  graph.addNode("coder_node", coderNode);
  graph.addNode("ui_designer_node", uiDesignerNode);
  graph.addNode("verify_node", verifyNode);
  graph.addNode("qa_node", qaNode);
  graph.addNode("legal_node", legalNode);
  graph.addNode("integration_node", integrationNode);
  graph.addNode("assembler_node", assemblerNode);
  // Passthrough node used as a hub after QA — lets fanOutRouterFn branch
  // to multiple downstream nodes without polluting coder_node's own edges.
  graph.addNode("fan_out_router", async (state: ExtensyState) => state);

  // Alias without strict generic so edge wiring compiles cleanly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = graph as any;

  // ── START → initial router ────────────────────────────────────────────────
  g.addConditionalEdges(START, initialRouterFn);

  // ── plan_node → approval gate ────────────────────────────────────────────
  g.addConditionalEdges("plan_node", planReviewGateFn);

  // ── architect_node → research router ─────────────────────────────────────
  g.addConditionalEdges("architect_node", researchRouterFn);

  // ── researcher_node → compaction → design brief → coder ─────────────────
  g.addEdge("researcher_node", "compaction_node");
  g.addEdge("compaction_node", "design_brief_node");
  g.addEdge("design_brief_node", "coder_node");

  // ── coder_node → ui_designer_router ──────────────────────────────────────
  g.addConditionalEdges("coder_node", uiDesignerRouterFn);

  // ── ui_designer_node → verify_node → qa_node ────────────────────────────
  g.addEdge("ui_designer_node", "verify_node");
  g.addConditionalEdges("verify_node", verifyRouterFn);

  // ── qa_node → qa router (retry loop or proceed) ──────────────────────────
  g.addConditionalEdges("qa_node", qaRouterFn);

  // ── fan_out_router → tier-specific downstream nodes ──────────────────────
  g.addConditionalEdges("fan_out_router", fanOutRouterFn);

  // ── legal_node & integration_node both funnel into assembler ─────────────
  g.addEdge("legal_node", "assembler_node");
  g.addEdge("integration_node", "assembler_node");

  // ── assembler_node → END ─────────────────────────────────────────────────
  g.addEdge("assembler_node", END);

  return graph.compile();
}


// ---------------------------------------------------------------------------
// Entry-point: run the pipeline
// ---------------------------------------------------------------------------

async function main() {
  const app = buildGraph();

  const initialState: Partial<ExtensyState> = {
    user_prompt:
      "Build a Chrome Extension that highlights all phone numbers on any webpage and shows a tooltip with a 'Call' button on hover.",
    subscription_tier: "max",
    planning_mode: true,
  };

  logger.info("Sidekick Engine — Starting pipeline", { input: initialState });

  try {
    const result = await app.invoke(initialState);

    if (result.error) {
      logger.error("Pipeline failed", { error: result.error });
      process.exit(1);
    }

    logger.info("Pipeline complete", {
      artifact: result.artifact_path,
      legalUrl: result.legal_url || "N/A",
      qaRetries: result.qa_retry_count,
    });
  } catch (err) {
    logger.error("Unhandled pipeline error", { error: String(err) });
    process.exit(1);
  }
}

// Run only when executed directly (not imported as a module).
if (require.main === module) {
  main();
}

export const __test__ = {
  architectNode,
  planNode,
  compactionNode,
  designBriefNode,
  coderNode,
  uiDesignerNode,
  researcherNode,
  qaNode,
  legalNode,
  integrationNode,
  verifyNode,
  assemblerNode,
  qaRouterFn,
  ensurePremiumPopup,
  findUngroundedExternalEndpoints,
};

export { buildGraph };
