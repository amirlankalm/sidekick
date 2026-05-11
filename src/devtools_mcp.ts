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
 *   - navigate               → navigate to a URL
 *
 * Architecture note:
 *   The MCP stdio transport spawns the server as a child and communicates
 *   over stdin/stdout using JSON-RPC 2.0. The MCP SDK handles framing.
 */

import type { QALogEntry } from "./state";
import { logger } from "./logger";

type McpTool = { name: string };
type McpToolResult = { tools: McpTool[] };
type McpClient = {
  connect: (transport: unknown) => Promise<void>;
  listTools: () => Promise<McpToolResult>;
  callTool: (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
  close: () => Promise<void>;
};

type McpSdkConstructors = {
  Client: new (
    clientInfo: { name: string; version: string },
    options: { capabilities: Record<string, unknown> }
  ) => McpClient;
  StdioClientTransport: new (options: {
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  }) => unknown;
};

function loadMcpSdk(): McpSdkConstructors {
  const { Client } = require("@modelcontextprotocol/sdk/client") as {
    Client: McpSdkConstructors["Client"];
  };
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js") as {
    StdioClientTransport: McpSdkConstructors["StdioClientTransport"];
  };

  return { Client, StdioClientTransport };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DevToolsDiagnostics {
  consoleLogs:   QALogEntry[];
  networkErrors: QALogEntry[];
  domIssues:     QALogEntry[];
  rawSummary:    string;
}

// ---------------------------------------------------------------------------
// Main export: runDevToolsDiagnostics
// ---------------------------------------------------------------------------

/**
 * Spawns the Chrome DevTools MCP server, connects to the Chrome instance
 * that Playwright launched (via its CDP port), and runs a suite of
 * diagnostic tools against the extension popup page.
 */
export async function runDevToolsDiagnostics(
  targetUrl: string,
  cdpPort: number = 9222,
  timeoutMs: number = 15000,
  requestId?: string
): Promise<DevToolsDiagnostics> {
  const log = logger.child({ node: "devtools_mcp", requestId });

  const diagnostics: DevToolsDiagnostics = {
    consoleLogs:   [],
    networkErrors: [],
    domIssues:     [],
    rawSummary:    "",
  };

  const npxPaths = ["/opt/homebrew/bin/npx", "/usr/local/bin/npx", "npx"];

  let client: McpClient | null = null;

  try {
    const { Client, StdioClientTransport } = loadMcpSdk();

    const npxBin =
      npxPaths.find((p) => {
        try {
          const fs = require("fs");
          return fs.existsSync(p);
        } catch {
          return false;
        }
      }) ?? "npx";

    log.info("Spawning Chrome DevTools MCP server", { npxBin });

    const transport = new StdioClientTransport({
      command: npxBin,
      args: ["chrome-devtools-mcp@latest"],
      env: {
        ...process.env,
        CHROME_DEVTOOLS_CDP_ENDPOINT: `http://localhost:${cdpPort}`,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
      },
    });

    client = new Client(
      { name: "sidekick-qa", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    log.info("Connected to Chrome DevTools MCP server");

    const toolsResult = await client.listTools();
    const availableTools = toolsResult.tools.map((t) => t.name);
    log.info("DevTools tools available", { tools: availableTools });

    const summaryParts: string[] = [];

    // ── Navigate to target URL ────────────────────────────────────────────
    if (availableTools.includes("navigate")) {
      try {
        await client.callTool({ name: "navigate", arguments: { url: targetUrl } });
        log.info("Navigated to target", { url: targetUrl });
        await sleep(2000);
      } catch (err) {
        log.warn("navigate tool failed", { error: String(err) });
      }
    }

    // ── Capture console messages ──────────────────────────────────────────
    if (availableTools.includes("console_messages")) {
      try {
        const result = await withTimeout(
          client.callTool({ name: "console_messages", arguments: {} }),
          timeoutMs / 3
        );

        const content = extractTextContent(result);
        if (content) {
          summaryParts.push(`## Console Messages\n${content}`);
          for (const line of content.split("\n")) {
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
        log.info("console_messages collected", { issues: diagnostics.consoleLogs.length });
      } catch (err) {
        log.warn("console_messages tool failed", { error: String(err) });
      }
    }

    // ── Network conditions ────────────────────────────────────────────────
    const networkToolNames = ["network_conditions", "get_network_requests", "network_requests"];
    const networkTool = networkToolNames.find((t) => availableTools.includes(t));

    if (networkTool) {
      try {
        const result = await withTimeout(
          client.callTool({ name: networkTool, arguments: {} }),
          timeoutMs / 3
        );

        const content = extractTextContent(result);
        if (content) {
          summaryParts.push(`## Network Requests\n${content}`);
          for (const line of content.split("\n")) {
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
        log.info("Network tool collected", { tool: networkTool, issues: diagnostics.networkErrors.length });
      } catch (err) {
        log.warn("Network tool failed", { tool: networkTool, error: String(err) });
      }
    }

    // ── DOM snapshot ──────────────────────────────────────────────────────
    const domToolNames = ["dom_snapshot", "get_dom", "screenshot"];
    const domTool = domToolNames.find((t) => availableTools.includes(t));

    if (domTool) {
      try {
        const result = await withTimeout(
          client.callTool({ name: domTool, arguments: {} }),
          timeoutMs / 3
        );

        const content = extractTextContent(result);
        if (content) {
          summaryParts.push(`## DOM Snapshot\n${content.slice(0, 3000)}`);

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
        log.info("DOM tool collected", { tool: domTool, issues: diagnostics.domIssues.length });
      } catch (err) {
        log.warn("DOM tool failed", { tool: domTool, error: String(err) });
      }
    }

    diagnostics.rawSummary = summaryParts.join("\n\n---\n\n");

    const totalIssues =
      diagnostics.consoleLogs.length +
      diagnostics.networkErrors.length +
      diagnostics.domIssues.length;

    log.info("DevTools diagnostics complete", { totalIssues });
  } catch (err) {
    logger.error("Fatal error during DevTools diagnostics", { error: String(err), requestId });
    diagnostics.rawSummary = `DevTools MCP diagnostic failed: ${String(err)}`;
  } finally {
    if (client) {
      try {
        await client.close();
      } catch (closeErr) {
        log.warn("MCP client close failed", { error: String(closeErr) });
      }
    }
  }

  return diagnostics;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
