/**
 * devtools_mcp.ts — Chrome DevTools MCP Integration
 *
 * Connects to the Chrome DevTools MCP server (chrome-devtools-mcp) via stdio
 * and exposes a typed API for the qa_node to perform real browser diagnostics.
 *
 * The MCP server is spawned as a child process via:
 *   npx chrome-devtools-mcp@latest
 *
 * It connects to an already-running Chrome instance (via CDP) and exposes
 * DevTools capabilities as MCP tools:
 *   - console_messages       → captured browser console output
 *   - network_conditions     → request/response inspection
 *   - dom_snapshot           → full page DOM tree
 *   - performance_trace_stop → Lighthouse-style perf trace
 *   - navigate               → navigate to a URL
 *   - click / type           → user simulation
 *
 * Architecture note:
 *   The MCP stdio transport spawns the server as a child and communicates
 *   over stdin/stdout using JSON-RPC 2.0. The MCP SDK handles framing.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import path from "path";
import type { QALogEntry } from "./state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DevToolsDiagnostics {
  /** Console errors/warnings captured by DevTools */
  consoleLogs: QALogEntry[];
  /** Network failures (4xx/5xx, blocked requests, CORS errors) */
  networkErrors: QALogEntry[];
  /** DOM structural issues (missing required elements, broken links) */
  domIssues: QALogEntry[];
  /** Raw summary text from DevTools (for coder_node prompt injection) */
  rawSummary: string;
}

// ---------------------------------------------------------------------------
// Main export: runDevToolsDiagnostics
// ---------------------------------------------------------------------------

/**
 * Spawns the Chrome DevTools MCP server, connects to the Chrome instance
 * that Playwright launched (via its CDP port), and runs a suite of
 * diagnostic tools against the extension popup page.
 *
 * @param targetUrl    The extension popup URL or page to inspect
 * @param cdpPort      Chrome remote debugging port (default: 9222)
 * @param timeoutMs    How long to wait for diagnostics (default: 15000ms)
 * @returns            Structured diagnostics + raw summary
 */
export async function runDevToolsDiagnostics(
  targetUrl: string,
  cdpPort: number = 9222,
  timeoutMs: number = 15000
): Promise<DevToolsDiagnostics> {
  const diagnostics: DevToolsDiagnostics = {
    consoleLogs: [],
    networkErrors: [],
    domIssues: [],
    rawSummary: "",
  };

  // Resolve npx path — we try common locations since PATH may not include them.
  const npxPaths = [
    "/opt/homebrew/bin/npx",
    "/usr/local/bin/npx",
    "npx",
  ];

  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  try {
    // ── 1. Find npx ────────────────────────────────────────────────────────
    const npxBin = npxPaths.find((p) => {
      try {
        const fs = require("fs");
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) ?? "npx";

    console.log(`[devtools_mcp] Spawning Chrome DevTools MCP server via ${npxBin}…`);

    // ── 2. Create stdio transport (spawns chrome-devtools-mcp as child) ────
    transport = new StdioClientTransport({
      command: npxBin,
      args: ["chrome-devtools-mcp@latest"],
      env: {
        ...process.env,
        // CDP endpoint — chrome-devtools-mcp connects to the Chrome instance
        // that Playwright already launched with --remote-debugging-port.
        CHROME_DEVTOOLS_CDP_ENDPOINT: `http://localhost:${cdpPort}`,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
      },
    });

    // ── 3. Create MCP client ───────────────────────────────────────────────
    client = new Client(
      { name: "sidekick-qa", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    console.log("[devtools_mcp] ✓ Connected to Chrome DevTools MCP server");

    // ── 4. List available tools ────────────────────────────────────────────
    const toolsResult = await client.listTools();
    const availableTools = toolsResult.tools.map((t) => t.name);
    console.log(`[devtools_mcp] Available tools: ${availableTools.join(", ")}`);

    const summaryParts: string[] = [];

    // ── 5. Navigate to target URL ──────────────────────────────────────────
    if (availableTools.includes("navigate")) {
      try {
        await client.callTool({
          name: "navigate",
          arguments: { url: targetUrl },
        });
        console.log(`[devtools_mcp] ✓ Navigated to ${targetUrl}`);
        // Brief pause for page to load
        await sleep(2000);
      } catch (err) {
        console.warn(`[devtools_mcp] navigate failed: ${String(err)}`);
      }
    }

    // ── 6. Capture console messages ────────────────────────────────────────
    if (availableTools.includes("console_messages")) {
      try {
        const result = await withTimeout(
          client.callTool({ name: "console_messages", arguments: {} }),
          timeoutMs / 3
        );

        const content = extractTextContent(result);
        if (content) {
          summaryParts.push(`## Console Messages\n${content}`);
          // Parse errors/warnings from the text
          const lines = content.split("\n");
          for (const line of lines) {
            if (/error|exception|uncaught/i.test(line)) {
              diagnostics.consoleLogs.push({
                type: "console",
                level: "error",
                message: line.trim(),
                captured_at: new Date().toISOString(),
              });
            } else if (/warn/i.test(line)) {
              diagnostics.consoleLogs.push({
                type: "console",
                level: "warning",
                message: line.trim(),
                captured_at: new Date().toISOString(),
              });
            }
          }
        }
        console.log(`[devtools_mcp] ✓ console_messages: ${diagnostics.consoleLogs.length} issues`);
      } catch (err) {
        console.warn(`[devtools_mcp] console_messages failed: ${String(err)}`);
      }
    }

    // ── 7. Inspect network conditions ─────────────────────────────────────
    const networkToolNames = ["network_conditions", "get_network_requests", "network_requests"];
    const networkTool = networkToolNames.find(t => availableTools.includes(t));

    if (networkTool) {
      try {
        const result = await withTimeout(
          client.callTool({ name: networkTool, arguments: {} }),
          timeoutMs / 3
        );

        const content = extractTextContent(result);
        if (content) {
          summaryParts.push(`## Network Requests\n${content}`);
          // Flag failed requests (CORS, 4xx, 5xx)
          const lines = content.split("\n");
          for (const line of lines) {
            if (/cors|blocked|failed|4\d\d|5\d\d/i.test(line)) {
              diagnostics.networkErrors.push({
                type: "pageerror",
                level: "error",
                message: line.trim(),
                captured_at: new Date().toISOString(),
              });
            }
          }
        }
        console.log(`[devtools_mcp] ✓ ${networkTool}: ${diagnostics.networkErrors.length} issues`);
      } catch (err) {
        console.warn(`[devtools_mcp] ${networkTool} failed: ${String(err)}`);
      }
    }

    // ── 8. DOM snapshot ────────────────────────────────────────────────────
    const domToolNames = ["dom_snapshot", "get_dom", "screenshot"];
    const domTool = domToolNames.find(t => availableTools.includes(t));

    if (domTool) {
      try {
        const result = await withTimeout(
          client.callTool({ name: domTool, arguments: {} }),
          timeoutMs / 3
        );

        const content = extractTextContent(result);
        if (content) {
          summaryParts.push(`## DOM Snapshot\n${content.slice(0, 3000)}`);

          // Flag common extension popup issues
          if (content.includes("404") || content.includes("not found")) {
            diagnostics.domIssues.push({
              type: "pageerror",
              level: "error",
              message: "DOM contains 404/not-found indicators",
              captured_at: new Date().toISOString(),
            });
          }

          if (!content.includes("<body") && !content.includes("body")) {
            diagnostics.domIssues.push({
              type: "pageerror",
              level: "warning",
              message: "DOM snapshot missing body element — popup may not have loaded",
              captured_at: new Date().toISOString(),
            });
          }
        }
        console.log(`[devtools_mcp] ✓ ${domTool}: ${diagnostics.domIssues.length} DOM issues`);
      } catch (err) {
        console.warn(`[devtools_mcp] ${domTool} failed: ${String(err)}`);
      }
    }

    // ── 9. Build raw summary ───────────────────────────────────────────────
    diagnostics.rawSummary = summaryParts.join("\n\n---\n\n");

    const totalIssues =
      diagnostics.consoleLogs.length +
      diagnostics.networkErrors.length +
      diagnostics.domIssues.length;

    console.log(`[devtools_mcp] ✅ Diagnostics complete — ${totalIssues} total issue(s) found`);
  } catch (err) {
    console.error("[devtools_mcp] Fatal error during diagnostics:", err);
    // Non-fatal: qa_node will fall back to Playwright-only logs
    diagnostics.rawSummary = `DevTools MCP diagnostic failed: ${String(err)}`;
  } finally {
    // ── 10. Clean up MCP connection ────────────────────────────────────────
    try {
      if (client) await client.close();
    } catch {
      // Ignore cleanup errors
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text content from an MCP tool result */
function extractTextContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return r.content
      .filter((c: unknown) => typeof c === "object" && (c as Record<string, unknown>).type === "text")
      .map((c: unknown) => (c as Record<string, unknown>).text as string)
      .join("\n");
  }
  if (typeof r.content === "string") return r.content;
  if (typeof r.text === "string") return r.text;
  return JSON.stringify(result);
}

/** Resolve a promise with a timeout */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

/** Simple sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
