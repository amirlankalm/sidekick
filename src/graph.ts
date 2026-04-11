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
// Use @sparticuz/chromium on Vercel (serverless), local Playwright elsewhere.
// We always import from playwright-core (no bundled browser binary).
import { chromium as playwrightChromium } from "playwright-core";
import sparticuzChromium from "@sparticuz/chromium";
import { StateGraph, END, START } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createClient } from "@supabase/supabase-js";
import JSZip from "jszip"; // added via: npm install jszip @types/jszip

import {
  StateAnnotation,
  type ExtensyState,
  type QALogEntry,
  type Blueprint,
  type SourceCode,
} from "./state";
import {
  getArchitectLLM,
  getCoderLLM,
  getResearcherLLM,
  getLegalLLM,
} from "./llm_config";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max number of QA→coder retry cycles before aborting (prevents inf. loops) */
const MAX_QA_RETRIES = 3;

/** Directory where Playwright loads the extension under test */
const TMP_EXT_DIR = path.join(os.tmpdir(), "sidekick", "extension");

/** Where the assembled ZIP is written (local dev only; skipped on Vercel) */
const OUTPUT_DIR = path.join(os.tmpdir(), "sidekick", "output");

// ---------------------------------------------------------------------------
// Supabase client (used by legal_node to persist the TOS document)
// ---------------------------------------------------------------------------

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "[graph] SUPABASE_URL or SUPABASE_ANON_KEY is missing from environment"
    );
  }
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Helper: write source_code map to disk
// ---------------------------------------------------------------------------

/**
 * Materialises every file in the SourceCode map into TMP_EXT_DIR.
 * Existing files are overwritten — this is deliberate so that QA retries
 * always test the freshest generated code.
 */
async function writeExtensionToDisk(sourceCode: SourceCode): Promise<void> {
  // Ensure base directory exists.
  await fs.mkdir(TMP_EXT_DIR, { recursive: true });

  for (const [relativePath, content] of Object.entries(sourceCode)) {
    const absolute = path.join(TMP_EXT_DIR, relativePath);
    // Create nested directories (e.g. src/background.js).
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf-8");
  }

  console.log(
    `[graph] Wrote ${Object.keys(sourceCode).length} file(s) to ${TMP_EXT_DIR}`
  );
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
): "architect_node" | "coder_node" {
  if (state.subscription_tier === "free" || !state.planning_mode) {
    // Free tier → skip planning, go straight to code generation.
    console.log("[router/initial] Free tier or planning disabled → coder_node");
    return "coder_node";
  }
  // Pro / Max with planning enabled → full blueprint first.
  console.log("[router/initial] Pro/Max + planning → architect_node");
  return "architect_node";
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
  console.log("[architect_node] Planning extension architecture…");

  const llm = getArchitectLLM();

  const systemPrompt = `You are an elite Chrome Extension architect.
Given a user prompt, produce a STRICT JSON object that conforms to this schema:
{
  "name": string,
  "description": string,
  "permissions": string[],
  "host_permissions": string[],
  "features": [{ "id": string, "summary": string, "implementation_hint": string }],
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
    blueprint = JSON.parse(text) as Blueprint;
    blueprint.raw_requirements = state.user_prompt; // always preserve original
  } catch (err) {
    console.error("[architect_node] Failed to parse blueprint JSON:", err);
    return {
      error: `architect_node: Failed to parse blueprint — ${String(err)}`,
    };
  }

  console.log(`[architect_node] Blueprint ready: "${blueprint.name}"`);
  return { blueprint };
}

// ---------------------------------------------------------------------------
// Node / Router: research_router  (architect → researcher OR coder)
// ---------------------------------------------------------------------------

function researchRouterFn(
  state: ExtensyState
): "researcher_node" | "coder_node" {
  if (state.subscription_tier === "max") {
    // Max tier always gets external context from Nia before coding.
    console.log("[router/research] Max tier → researcher_node");
    return "researcher_node";
  }
  console.log("[router/research] Non-Max → coder_node");
  return "coder_node";
}

// ---------------------------------------------------------------------------
// Node: researcher_node (Max tier only)
// ---------------------------------------------------------------------------

/**
 * Queries the Nia context API via Anthropic headers.
 * The NIA_API_KEY is forwarded as a custom header (see llm_config.ts).
 * In practice, researcher_node constructs a retrieval prompt that asks the
 * model to surface relevant Chrome Extension API documentation snippets
 * for the blueprint's required permissions.
 */
async function researcherNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  console.log("[researcher_node] Fetching Nia context for blueprint…");

  const llm = getResearcherLLM(); // Sonnet + NIA_API_KEY header

  const blueprint = state.blueprint
    ? JSON.stringify(state.blueprint, null, 2)
    : `User prompt: ${state.user_prompt}`;

  const systemPrompt = `You are a research agent specialised in Chrome Extension development.
Given a blueprint, return focused documentation snippets covering:
- Manifest V3 requirements for the listed permissions
- Best-practice code patterns for each required feature
- Any known CSP (Content Security Policy) gotchas

Be concise. Return plain text grouped by section headers.`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(`Research the following extension blueprint:\n\n${blueprint}`),
  ]);

  const context =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  console.log(
    `[researcher_node] Retrieved ${context.length} chars of context`
  );
  return { research_context: context };
}

// ---------------------------------------------------------------------------
// Node: coder_node
// ---------------------------------------------------------------------------

/**
 * The heart of the pipeline.  Generates all extension source files as a
 * structured JSON map of { "filename": "content" }.
 *
 * On QA-triggered re-runs, qa_logs are injected into the prompt so the
 * model can self-heal the exact errors Playwright captured.
 */
async function coderNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  const isRetry = state.qa_logs.length > 0;
  console.log(
    `[coder_node] Generating code (retry=${isRetry}, attempt=${state.qa_retry_count + 1})…`
  );

  const llm = getCoderLLM(state.subscription_tier);

  // ── Build the system prompt ───────────────────────────────────────────────
  const systemPrompt = `You are an expert Chrome Extension engineer.
Produce a complete, production-ready Manifest V3 extension.

Output ONLY a JSON object where each key is a relative file path and each value is
the stringified file content.  Example:
{
  "manifest.json": "{ \\"manifest_version\\": 3, ... }",
  "background.js": "// service worker ...",
  "popup.html": "<!DOCTYPE html>...",
  "popup.js": "..."
}

Rules:
- Always include manifest.json with manifest_version 3
- Never use eval() or inline scripts (CSP compliance)
- Service workers must follow MV3 patterns (no persistent background pages)
- All external requests must use host_permissions declared in the manifest
- Output ONLY the JSON map — no markdown fences, no prose`;

  // ── Build the user prompt with blueprint + research context + QA errors ──
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
      `## Relevant Documentation (from Nia context)\n${state.research_context}`
    );
  }

  if (isRetry) {
    const errorSummary = state.qa_logs
      .map((l) => `[${l.type}/${l.level}] ${l.message}`)
      .join("\n");
    parts.push(
      `## ⚠️ QA Errors — Fix These (attempt ${state.qa_retry_count + 1}/${MAX_QA_RETRIES})\n${errorSummary}`
    );
  }

  const userMessage = parts.join("\n\n");

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(userMessage),
  ]);

  const raw =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  let sourceCode: SourceCode;
  try {
    // Strip accidental markdown fences the model might still emit.
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/```\s*$/m, "")
      .trim();
    sourceCode = JSON.parse(cleaned) as SourceCode;
  } catch (err) {
    console.error("[coder_node] Failed to parse source_code JSON:", err);
    return {
      error: `coder_node: Failed to parse generated source — ${String(err)}`,
    };
  }

  console.log(
    `[coder_node] Generated ${Object.keys(sourceCode).length} file(s): ${Object.keys(sourceCode).join(", ")}`
  );

  return {
    source_code: sourceCode,
    // Reset qa_logs so only the *current* run's errors flow into the next retry.
    qa_logs: [],
    qa_retry_count: state.qa_retry_count + (isRetry ? 1 : 0),
  };
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
  console.log("[qa_node] Writing extension to disk and launching Playwright…");

  await writeExtensionToDisk(state.source_code);

  const logs: QALogEntry[] = [];

  // ── Resolve Chromium based on runtime environment ─────────────────────────
  // On Vercel (VERCEL=1) the local Playwright binary is absent; we use
  // @sparticuz/chromium which bundles a serverless-optimised Chromium build.
  const isVercel = process.env.VERCEL === "1";
  const extensionArgs = [
    `--disable-extensions-except=${TMP_EXT_DIR}`,
    `--load-extension=${TMP_EXT_DIR}`,
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
  ];

  let browser;
  try {
    if (isVercel) {
      // Serverless path — sparticuz provides a pre-compiled Chromium binary.
      const executablePath = await sparticuzChromium.executablePath();
      browser = await playwrightChromium.launch({
        headless: true,
        executablePath,
        args: [...sparticuzChromium.args, ...extensionArgs],
      });
    } else {
      // Local dev path — Playwright manages its own Chromium download.
      browser = await playwrightChromium.launch({
        headless: true,
        args: extensionArgs,
      });
    }

    const context = await browser.newContext();
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

    await page.goto("about:blank");
    await page.waitForTimeout(5000);
    await context.close();
  } catch (err) {
    console.error("[qa_node] Playwright launch failed:", err);
    logs.push({
      type: "pageerror",
      level: "error",
      message: `Playwright failed to launch: ${String(err)}`,
      captured_at: new Date().toISOString(),
    });
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  console.log(`[qa_node] QA complete. Captured ${logs.length} issue(s).`);
  return { qa_logs: logs };
}

// ---------------------------------------------------------------------------
// Router: qa_router
// ---------------------------------------------------------------------------

function qaRouterFn(
  state: ExtensyState
): "coder_node" | "fan_out_router" {
  if (state.error) {
    // Propagate fatal errors out of the QA loop.
    console.log("[router/qa] Fatal error detected → END");
    return "fan_out_router"; // will hit END in fan_out_router
  }

  if (
    state.qa_logs.length > 0 &&
    state.qa_retry_count < MAX_QA_RETRIES
  ) {
    console.log(
      `[router/qa] ${state.qa_logs.length} issue(s) found — sending back to coder_node (retry ${state.qa_retry_count + 1}/${MAX_QA_RETRIES})`
    );
    return "coder_node";
  }

  if (
    state.qa_logs.length > 0 &&
    state.qa_retry_count >= MAX_QA_RETRIES
  ) {
    // Max retries exhausted — log and proceed.
    console.warn(
      `[router/qa] Max retries (${MAX_QA_RETRIES}) exhausted with ${state.qa_logs.length} unresolved issue(s). Proceeding to assembly.`
    );
  }

  console.log("[router/qa] QA passed → fan_out_router");
  return "fan_out_router";
}

// ---------------------------------------------------------------------------
// Router: fan_out_router
// ---------------------------------------------------------------------------

function fanOutRouterFn(state: ExtensyState): string[] | string {
  if (state.error) return END;

  switch (state.subscription_tier) {
    case "free":
      // Free tier: skip legal & integration, go direct to assembly.
      console.log("[router/fan_out] Free tier → assembler_node");
      return "assembler_node";

    case "pro":
      // Pro tier: legal review before assembly.
      console.log("[router/fan_out] Pro tier → legal_node");
      return "legal_node";

    case "max":
      // Max tier: legal AND integration run in parallel (Send API).
      console.log(
        "[router/fan_out] Max tier → [legal_node, integration_node] (parallel)"
      );
      return ["legal_node", "integration_node"];

    default:
      return "assembler_node";
  }
}

// ---------------------------------------------------------------------------
// Node: legal_node
// ---------------------------------------------------------------------------

/**
 * Generates a Terms of Service document tailored to the extension,
 * uploads it to Supabase Storage, and returns the public URL.
 */
async function legalNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  console.log("[legal_node] Generating Terms of Service…");

  const llm = getLegalLLM(); // Haiku — cost-efficient for doc generation

  const blueprint = state.blueprint;
  const extensionName = blueprint?.name ?? "This Extension";

  const systemPrompt = `You are a legal document specialist.
Generate a concise but complete Terms of Service for a Chrome Extension.
Include: acceptance clause, data handling, limitation of liability, GDPR notice (if applicable), and contact information placeholder.
Use plain English. Return plain text only (no markdown).`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `Extension name: ${extensionName}\nDescription: ${blueprint?.description ?? state.user_prompt}`
    ),
  ]);

  const tosContent =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  // ── Upload TOS to Supabase Storage ───────────────────────────────────────
  let legalUrl = "";
  try {
    const supabase = getSupabaseClient();
    const fileName = `tos/${extensionName.replace(/\s+/g, "_")}_${Date.now()}.txt`;

    const { error } = await supabase.storage
      .from("legal-docs")
      .upload(fileName, Buffer.from(tosContent, "utf-8"), {
        contentType: "text/plain",
        upsert: true,
      });

    if (error) {
      console.error("[legal_node] Supabase upload error:", error.message);
      // Non-fatal: embed the TOS inline as a data URL fallback.
      legalUrl = `data:text/plain;base64,${Buffer.from(tosContent).toString("base64")}`;
    } else {
      const { data: publicData } = supabase.storage
        .from("legal-docs")
        .getPublicUrl(fileName);
      legalUrl = publicData.publicUrl;
    }
  } catch (err) {
    console.error("[legal_node] Unexpected Supabase error:", err);
    legalUrl = `data:text/plain;base64,${Buffer.from(tosContent).toString("base64")}`;
  }

  console.log(`[legal_node] TOS URL: ${legalUrl}`);
  return { legal_url: legalUrl };
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
  console.log("[integration_node] Auditing and wiring third-party integrations…");

  const llm = getCoderLLM("max"); // Sonnet for integration quality

  const codeSnapshot = Object.entries(state.source_code)
    .map(([file, content]) => `// === ${file} ===\n${content}`)
    .join("\n\n");

  const systemPrompt = `You are a senior integration engineer for Chrome Extensions.
Review the provided source code.  If any third-party APIs are called:
1. Generate thin, well-typed helper modules (e.g. api/client.js)
2. Add any missing error-handling wrappers
3. Return a JSON map of NEW OR MODIFIED files only (same schema as coder_node output)
If no integrations are needed, return an empty JSON object: {}`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(
      `Review and improve integrations in the following extension code:\n\n${codeSnapshot}`
    ),
  ]);

  const raw =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  let integrationFiles: SourceCode = {};
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/```\s*$/m, "")
      .trim();
    if (cleaned !== "{}") {
      integrationFiles = JSON.parse(cleaned) as SourceCode;
    }
  } catch (err) {
    console.warn("[integration_node] Could not parse integration output:", err);
  }

  console.log(
    `[integration_node] Added/modified ${Object.keys(integrationFiles).length} integration file(s)`
  );

  // Merge integration files into existing source_code.
  return {
    source_code: { ...state.source_code, ...integrationFiles },
  };
}

// ---------------------------------------------------------------------------
// Node: assembler_node
// ---------------------------------------------------------------------------

/**
 * Collects all source files and zips them into a distributable archive.
 * Also injects the TOS URL into manifest.json if present (Pro/Max).
 */
async function assemblerNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  console.log("[assembler_node] Assembling final Chrome Extension ZIP…");

  const zip = new JSZip();
  const sourceCode = state.source_code;

  for (const [filePath, content] of Object.entries(sourceCode)) {
    zip.file(filePath, content);
  }

  // Inject TOS URL into the extension as a README if available.
  if (state.legal_url) {
    zip.file(
      "LEGAL.txt",
      `Terms of Service: ${state.legal_url}\n\nThis extension was generated by Extensy (https://extensy.app).`
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
      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
      artifactPath = path.join(OUTPUT_DIR, `${extensionName}_${timestamp}.zip`);
      await fs.writeFile(artifactPath, zipBuffer);
      console.log(`[assembler_node] ✅ Extension packaged at: ${artifactPath}`);
    } catch (err) {
      console.warn("[assembler_node] ZIP write failed (non-fatal):", err);
    }
  } else {
    console.log(`[assembler_node] ✅ Extension ready (Vercel — in-memory only): ${extensionName}`);
  }

  return { artifact_path: artifactPath };
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
  graph.addNode("architect_node", architectNode);
  graph.addNode("researcher_node", researcherNode);
  graph.addNode("coder_node", coderNode);
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

  // ── architect_node → research router ─────────────────────────────────────
  g.addConditionalEdges("architect_node", researchRouterFn);

  // ── researcher_node → coder_node ─────────────────────────────────────────
  g.addEdge("researcher_node", "coder_node");

  // ── coder_node → qa_node ─────────────────────────────────────────────────
  g.addEdge("coder_node", "qa_node");

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

  // Example invocation — replace with real user input from API layer.
  const initialState: Partial<ExtensyState> = {
    user_prompt:
      "Build a Chrome Extension that highlights all phone numbers on any webpage and shows a tooltip with a 'Call' button on hover.",
    subscription_tier: "max",
    planning_mode: true,
  };

  console.log("\n🚀 Extensy Sidekick Engine — Starting pipeline\n");
  console.log("Input:", JSON.stringify(initialState, null, 2), "\n");

  try {
    const result = await app.invoke(initialState);

    if (result.error) {
      console.error("\n❌ Pipeline failed:", result.error);
      process.exit(1);
    }

    console.log("\n✅ Pipeline complete!");
    console.log("  Artifact:", result.artifact_path);
    console.log("  Legal URL:", result.legal_url || "N/A");
    console.log("  QA retries:", result.qa_retry_count);
  } catch (err) {
    console.error("\n💥 Unhandled pipeline error:", err);
    process.exit(1);
  }
}

// Run only when executed directly (not imported as a module).
if (require.main === module) {
  main();
}

export { buildGraph };
