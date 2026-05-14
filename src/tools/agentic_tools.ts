/**
 * agentic_tools.ts — OpenCode-style tool definitions for the agentic coder loop
 *
 * Mirrors OpenCode's tool registry (read / write / edit / list / bash) but
 * operates on Sidekick's in-memory SourceCode workspace instead of the real
 * filesystem. bash_check is the exception — it writes to a temp path to run
 * `node --check` syntax validation.
 *
 * OpenCode reference:
 *   packages/opencode/src/tool/registry.ts  (BashTool, ReadTool, WriteTool, EditTool, GlobTool)
 *   packages/opencode/src/session/prompt/gemini.txt (workflow: understand → plan → implement → verify)
 */

import fs from "fs/promises";
import path from "path";
import { runCommand } from "./wrappers";
import { evaluatePermission, type ToolContext } from "./registry";
import type { SourceCode } from "../state";
import type { ToolDefinition } from "../llm_config";

// ---------------------------------------------------------------------------
// Tool registry — write_file / edit_file / read_file / list_files / bash_check
// ---------------------------------------------------------------------------

export const CODER_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a complete file to the extension workspace. Creates or overwrites the file. " +
        "Use for manifest.json, popup.html, popup.css, popup.js, background.js, content scripts, etc. " +
        "Write files incrementally — one at a time — rather than generating everything in a single JSON blob. " +
        "NEVER use markdown code fences inside the content value.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative file path within the extension (e.g. 'manifest.json', 'popup.html', 'lib/utils.js'). " +
              "Never use '..' segments or absolute paths.",
          },
          content: {
            type: "string",
            description:
              "Complete, production-ready file content. Well-formatted, never minified. " +
              "No outer markdown fences — just the raw file text.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Apply a precise string replacement to an existing workspace file. " +
        "Use when fixing a localised bug without rewriting the whole file. " +
        "The old_string must appear exactly once in the file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path of the file to edit.",
          },
          old_string: {
            type: "string",
            description: "Exact string to find in the file. Must be unique — provide enough surrounding context.",
          },
          new_string: {
            type: "string",
            description: "Replacement string.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the current content of a workspace file. " +
        "Use before editing to verify the exact content or after writing to check the result.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path to read.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files currently in the workspace. Use to see what has been written so far.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash_check",
      description:
        "Run 'node --check' on a .js file in the workspace to detect syntax errors before the browser QA phase. " +
        "Returns 'OK: no syntax errors' on success or the error message on failure. Only works on .js files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to the .js file to syntax-check.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_workspace",
      description:
        "Search for a string pattern across all files in the workspace. " +
        "Returns matching lines with file names and 1-based line numbers. " +
        "Use to locate a symbol, selector, or value before editing — avoids reading entire files.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Case-sensitive substring to search for across all workspace files.",
          },
        },
        required: ["pattern"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export interface AgentToolResult {
  output: string;
  isError: boolean;
}

export async function executeAgentTool(
  name: string,
  rawArgs: unknown,
  workspace: SourceCode,
  ctx: ToolContext,
  tmpDir: string
): Promise<AgentToolResult> {
  const args =
    rawArgs !== null &&
    typeof rawArgs === "object" &&
    !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  switch (name) {
    case "write_file": {
      const filePath = sanitizePath(String(args["path"] ?? ""));
      const content = String(args["content"] ?? "");
      if (!filePath) return { output: "Error: path is required", isError: true };
      workspace[filePath] = content;
      return {
        output: `File written: ${filePath} (${content.length} chars)`,
        isError: false,
      };
    }

    case "edit_file": {
      const filePath = sanitizePath(String(args["path"] ?? ""));
      const oldString = String(args["old_string"] ?? "");
      const newString = String(args["new_string"] ?? "");
      if (!filePath) return { output: "Error: path is required", isError: true };
      const current = workspace[filePath];
      if (current === undefined) {
        const available = Object.keys(workspace).join(", ") || "(empty)";
        return {
          output: `Error: file not found: ${filePath}. Available files: ${available}`,
          isError: true,
        };
      }
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) {
        return {
          output: `Error: old_string not found in ${filePath}. Provide a longer, more unique substring.`,
          isError: true,
        };
      }
      if (occurrences > 1) {
        return {
          output: `Error: old_string appears ${occurrences} times in ${filePath} — provide more context to make it unique.`,
          isError: true,
        };
      }
      workspace[filePath] = current.replace(oldString, newString);
      return { output: `File edited: ${filePath}`, isError: false };
    }

    case "read_file": {
      const filePath = sanitizePath(String(args["path"] ?? ""));
      if (!filePath) return { output: "Error: path is required", isError: true };
      const content = workspace[filePath];
      if (content === undefined) {
        const available = Object.keys(workspace).join(", ") || "(empty)";
        return {
          output: `Error: file not found: ${filePath}. Available: ${available}`,
          isError: true,
        };
      }
      return { output: content, isError: false };
    }

    case "list_files": {
      const files = Object.keys(workspace);
      return {
        output:
          files.length === 0 ? "(workspace is empty)" : files.join("\n"),
        isError: false,
      };
    }

    case "bash_check": {
      const filePath = sanitizePath(String(args["path"] ?? ""));
      if (!filePath) return { output: "Error: path is required", isError: true };
      if (!filePath.endsWith(".js")) {
        return {
          output: "Error: bash_check only supports .js files",
          isError: true,
        };
      }
      const content = workspace[filePath];
      if (content === undefined) {
        return {
          output: `Error: file not found: ${filePath}`,
          isError: true,
        };
      }
      const shellDecision = evaluatePermission(ctx, "shell", ["node --check"]);
      if (shellDecision === "deny") {
        return {
          output: "bash_check skipped: shell execution not available for this subscription tier",
          isError: false,
        };
      }
      const absolutePath = path.join(tmpDir, filePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf-8");
      const result = await runCommand(ctx, "node", ["--check", absolutePath], {
        cwd: tmpDir,
        timeoutMs: 15_000,
      });
      const combined = [result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      return result.code === 0
        ? { output: "OK: no syntax errors", isError: false }
        : { output: combined || "Syntax error detected", isError: true };
    }

    case "grep_workspace": {
      const pattern = String(args["pattern"] ?? "");
      if (!pattern) return { output: "Error: pattern is required", isError: true };
      const matches: string[] = [];
      for (const [filePath, content] of Object.entries(workspace)) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(pattern)) {
            matches.push(`${filePath}:${i + 1}: ${lines[i]}`);
          }
        }
      }
      return {
        output: matches.length > 0 ? matches.join("\n") : "(no matches)",
        isError: false,
      };
    }

    default:
      return { output: `Error: unknown tool '${name}'`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizePath(raw: string): string {
  return path
    .normalize(raw)
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .replace(/^\/+/, "")
    .trim();
}
