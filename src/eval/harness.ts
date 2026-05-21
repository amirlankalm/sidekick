/**
 * harness.ts — Shared mock infrastructure for the eval suite
 *
 * Provides deterministic, zero-cost mock LLMs and Supabase clients so
 * every eval criterion runs without live API calls.  Each factory accepts
 * a scenario-specific response payload and wires it into the graph via
 * the existing test-injection hooks.
 */

import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import {
  setLLMFactoryForTests,
  resetLLMFactoryForTests,
  type LLMFactoryOptions,
  type SidekickLLM,
  type ApiMessage,
  type AgentTurnResult,
  type ToolDefinition,
} from "../llm_config";
import {
  setSupabaseClientForTests,
  resetSupabaseClientForTests,
} from "../graph";
import type { Blueprint, SourceCode } from "../state";

// ─── Standard test fixtures ───────────────────────────────────────────────────

export const VALID_BLUEPRINT: Blueprint = {
  name: "Focus Timer",
  description: "Pomodoro timer that highlights the active tab.",
  permissions: ["activeTab", "scripting", "alarms"],
  host_permissions: [],
  features: [
    { id: "timer", summary: "25-minute countdown displayed in popup" },
    { id: "tab_highlight", summary: "Highlights active tab border when running" },
  ],
  design_profile: "Apple Minimalist",
  raw_requirements: "Build a pomodoro timer chrome extension",
};

export const VALID_SOURCE: SourceCode = {
  "manifest.json": JSON.stringify({
    manifest_version: 3,
    name: "Focus Timer",
    version: "1.0.0",
    description: "Pomodoro timer that highlights the active tab.",
    permissions: ["activeTab", "scripting", "alarms"],
    action: { default_popup: "popup.html" },
    background: { service_worker: "background.js" },
  }, null, 2),
  "popup.html": "<!DOCTYPE html><html><head><link rel='stylesheet' href='popup.css'></head><body><h1>Focus Timer</h1><button id='start'>Start</button><script src='popup.js'></script></body></html>",
  "popup.css": "body{font-family:system-ui;margin:16px}button{padding:8px 16px;border-radius:6px;border:none;cursor:pointer;background:#0f766e;color:#fff}",
  "popup.js": "const btn=document.getElementById('start');btn.addEventListener('click',()=>chrome.alarms.create('timer',{delayInMinutes:25}));",
  "background.js": "chrome.alarms.onAlarm.addListener(alarm=>{ if(alarm.name==='timer') chrome.notifications.create({type:'basic',title:'Time up!',message:'Break time.',iconUrl:'icon.png'}); });",
};

export const MINIMAL_VALID_MANIFEST = {
  manifest_version: 3,
  name: "Test Ext",
  version: "1.0.0",
  description: "A test extension",
  permissions: ["activeTab"],
  action: { default_popup: "popup.html" },
};

// ─── Mock LLM factory ─────────────────────────────────────────────────────────

type TurnSpec =
  | { kind: "text"; content: string }
  | { kind: "tools"; calls: Array<{ name: string; args: Record<string, unknown> }> };

/** Build a mock LLM that plays back a preset turn sequence. */
export function makeMockLLM(turns: TurnSpec[]): SidekickLLM {
  let step = 0;
  return {
    async invokeWithTools(messages: ApiMessage[], tools: ToolDefinition[]): Promise<AgentTurnResult> {
      const turn = turns[Math.min(step++, turns.length - 1)];

      if (turn.kind === "tools" && tools.length > 0) {
        return {
          content: null,
          rawToolCalls: turn.calls.map((c, i) => ({
            id: `mock-${step}-${i}`,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
          finishReason: "tool_calls",
        };
      }

      return {
        content: turn.kind === "text" ? turn.content : "{}",
        rawToolCalls: [],
        finishReason: "stop",
      };
    },
    invoke: async (_messages) => {
      const t = turns[Math.min(step++, turns.length - 1)];
      return { content: t.kind === "text" ? t.content : "{}" };
    },
  };
}

/** Install a global mock that returns the same LLM for every role. */
export function installMockLLM(turns: TurnSpec[]): () => void {
  const mock = makeMockLLM(turns);
  setLLMFactoryForTests((_opts: LLMFactoryOptions) => mock);
  return resetLLMFactoryForTests;
}

/** Install a role-aware mock (different responses per node role). */
export function installRoleAwareMockLLM(
  roleMap: Partial<Record<string, TurnSpec[]>>
): () => void {
  setLLMFactoryForTests((opts: LLMFactoryOptions) => {
    const turns = roleMap[opts.role] ?? roleMap["default"] ?? [{ kind: "text", content: "{}" }];
    return makeMockLLM(turns);
  });
  return resetLLMFactoryForTests;
}

// ─── Mock Supabase factory ────────────────────────────────────────────────────

export interface MockSupabaseOptions {
  uploadSuccess?: boolean;
  publicUrl?: string;
  userTier?: string;
}

export function installMockSupabase(opts: MockSupabaseOptions = {}): () => void {
  const publicUrl = opts.publicUrl ?? "https://mock.supabase.co/storage/v1/object/public/test/doc.pdf";
  const uploadSuccess = opts.uploadSuccess ?? true;

  setSupabaseClientForTests(() => ({
    storage: {
      from: (_bucket: string) => ({
        upload: async (_path: string, _data: unknown) =>
          uploadSuccess
            ? { data: { path: _path }, error: null }
            : { data: null, error: new Error("mock upload failure") },
        getPublicUrl: (_path: string) => ({ data: { publicUrl } }),
      }),
    },
    auth: {
      getUser: async () => ({
        data: {
          user: { id: "mock-user-id", email: "test@extensy.dev" },
        },
        error: null,
      }),
    },
  }));

  return resetSupabaseClientForTests;
}

// ─── Scratch worktree ─────────────────────────────────────────────────────────

export function tempWorktree(): string {
  return path.join(os.tmpdir(), `sk-eval-${process.pid}-${randomUUID().slice(0, 8)}`);
}

// ─── Timer helper ─────────────────────────────────────────────────────────────

export async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const result = await fn();
  return [result, Date.now() - start];
}

// ─── LLM response builders ────────────────────────────────────────────────────

/** JSON-stringified blueprint response for architect_node mocks. */
export function blueprintResponse(override: Partial<Blueprint> = {}): string {
  return JSON.stringify({ ...VALID_BLUEPRINT, ...override });
}

/** Write-file tool sequence that produces a valid extension workspace. */
export function writeFileTurns(sourceCode: SourceCode): TurnSpec[] {
  const writes: TurnSpec[] = Object.entries(sourceCode).map(([filePath, content]) => ({
    kind: "tools",
    calls: [{ name: "write_file", args: { path: filePath, content } }],
  }));
  writes.push({ kind: "text", content: JSON.stringify(sourceCode) });
  return writes;
}
