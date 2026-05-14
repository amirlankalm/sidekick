import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import type { BaseMessage } from "@langchain/core/messages";
import { bus, type BusEvent } from "./bus";
import { buildGraph, __test__, setSupabaseClientForTests, resetSupabaseClientForTests, setFetchDocPageForTests, resetFetchDocPageForTests, setContext7GroundingForTests, resetContext7GroundingForTests } from "./graph";
import {
  resetLLMFactoryForTests,
  setLLMFactoryForTests,
  type LLMFactoryOptions,
  type SidekickLLM,
  type ApiMessage,
  type AgentTurnResult,
  type ToolDefinition,
} from "./llm_config";
import { setNiaClientForTests, resetNiaClientForTests } from "./nia";
import {
  createToolContext,
  evaluatePermission,
  type ToolContext,
} from "./tools/registry";
import type { ExtensyState, SourceCode } from "./state";

const cleanExtension: SourceCode = {
  "manifest.json": JSON.stringify(
    {
      manifest_version: 3,
      name: "Focus Clipper",
      version: "1.0.0",
      description: "Clip useful text from the current tab.",
      permissions: ["activeTab", "scripting"],
      action: { default_popup: "popup.html" },
    },
    null,
    2
  ),
  "popup.html": "<main><h1>Focus Clipper</h1><button id=\"save\">Save</button></main>",
  "popup.css": "body{font-family:sans-serif}",
  "popup.js": "document.getElementById('save')?.addEventListener('click', () => console.log('saved'));",
};

const hallucinatedExtension: SourceCode = {
  ...cleanExtension,
  "popup.js": "fetch('https://api.fake-ai-summarizer.example/v1/run').then(() => undefined);",
};

function messageText(message: BaseMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function makeMockInvokeWithTools(
  source: SourceCode
): (messages: ApiMessage[], _tools: ToolDefinition[]) => Promise<AgentTurnResult> {
  return async (_messages: ApiMessage[], _tools: ToolDefinition[]): Promise<AgentTurnResult> => ({
    content: JSON.stringify(source),
    rawToolCalls: [],
    finishReason: "stop",
  });
}

function installMockLLM(source: SourceCode = cleanExtension): void {
  setLLMFactoryForTests((options: LLMFactoryOptions): SidekickLLM => ({
    async invoke(messages: BaseMessage[]) {
      const prompt = messages.map(messageText).join("\n\n");

      if (prompt.includes("read-only planning agent")) {
        return {
          content: JSON.stringify({
            summary: "Build a focused MV3 popup extension with local-only behavior.",
            steps: [
              {
                node: "architect_node",
                description: "Produce MV3 blueprint and permissions.",
                files: ["manifest.json"],
                estimatedTokens: 900,
              },
              {
                node: "coder_node",
                description: "Generate popup files and content script.",
                files: ["popup.html", "popup.css", "popup.js"],
                estimatedTokens: 2200,
              },
            ],
          }),
        };
      }

      if (prompt.includes("Summarize the following development context")) {
        return { content: "Compact brief: preserve MV3 popup files, local-only behavior, and unresolved diagnostics." };
      }

      if (options.role === "architect") {
        if (prompt.includes("Nia Design & API Context") || prompt.includes("Synthesize the provided")) {
          return {
            content: "## Chrome API Patterns\nUse chrome.scripting for injection.\n\n## Nia context\nEditorial Utility tokens: --bg:#f5f5f4; --ink:#0f0f0f; --accent:#0f766e;",
          };
        }
        return {
          content: JSON.stringify({
            name: "Focus Clipper",
            description: "Clip useful text from the current tab.",
            permissions: ["activeTab", "scripting"],
            host_permissions: [],
            features: [
              {
                id: "clip-text",
                summary: "Capture selected page text locally.",
                implementation_hint: "Use chrome.scripting only on the active tab.",
              },
            ],
            design_profile: "Editorial Utility",
            connectors: [],
            raw_requirements: "Build a local clipping extension.",
          }),
        };
      }

      if (options.role === "ui_designer" && prompt.includes("componentHierarchy")) {
        return {
          content: JSON.stringify({
            designTokens: {
              colors: {
                primary: "#0f766e",
                background: "#f5f5f4",
                surface: "#ffffff",
                border: "#e5e5e5",
                text: "#0f0f0f",
                muted: "#6b7280",
                accent: "#0f766e",
                error: "#dc2626",
              },
              borderRadius: "6px",
              fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
              spacingUnit: "4px",
            },
            componentHierarchy: [
              { name: "PopupRoot", children: ["Header", "PrimaryActionArea", "ContextStrip", "Footer"] },
            ],
            layout: "popup",
            iconSet: "inline-svg",
            responsive: true,
            darkMode: "media-query",
            requiredStates: ["loading", "empty", "error", "no-api-key", "offline"],
          }),
        };
      }

      if (options.role === "ui_designer") return { content: "{}" };
      if (options.role === "legal") return { content: "Plain legal document." };
      if (options.role === "router" && prompt.includes("research questions")) {
        return { content: "https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions" };
      }
      if (options.role === "router") {
        return { content: "1. Which MV3 permissions are required?\n2. Which popup files are needed?" };
      }
      return { content: JSON.stringify(source) };
    },

    invokeWithTools: makeMockInvokeWithTools(source),
  }));
}

function installMockNia(): void {
  setNiaClientForTests(() => ({
    async searchWeb(query: string): Promise<string> {
      return `**Chrome MV3 Web Grounding** (${query.slice(0, 40)}): chrome.scripting.executeScript injects content scripts. chrome.storage.local.set/get for persistence.`;
    },
    async searchQuery(query: string): Promise<string> {
      return `Nia query context: ${query.slice(0, 60)}. Chrome MV3: use chrome.scripting for injection, chrome.storage.local for persistence. Editorial Utility tokens: --bg:#f5f5f4; --ink:#0f0f0f; --accent:#0f766e;`;
    },
    async searchDeep(query: string): Promise<string> {
      return `Nia deep research: ${query.slice(0, 60)}. Authoritative Chrome Extension MV3 patterns — chrome.scripting.executeScript({target:{tabId},func}), chrome.storage.local.set({key:value}), service worker via background.service_worker in manifest. No eval(), no inline scripts per CSP.`;
    },
  }));
}

function installMockSupabase(): void {
  setSupabaseClientForTests(() => ({
    storage: {
      from: (_bucket: string) => ({
        upload: async () => ({ error: new Error("test-mock: no Supabase bucket"), data: null }),
        getPublicUrl: (_path: string) => ({ data: { publicUrl: "" } }),
      }),
    },
  }));
}

function installMockFetch(): void {
  setFetchDocPageForTests(async (url: string) => {
    return `--- Source: ${url} ---\nMocked doc: MV3 service workers, chrome.scripting API, declarative content rules.`;
  });
}

function installMockContext7(): void {
  setContext7GroundingForTests(async (combinedText: string, permissions: string[]) => {
    const parts = [
      `## Chrome Extension MV3 — Live Docs (context7)\n\nchrome.storage.local.set({key: value}, callback). chrome.tabs.query({active: true, currentWindow: true}). Service worker registered via background.service_worker in manifest.json. Content scripts declared via content_scripts[].js. No eval(), no inline scripts (MV3 CSP). Permissions: ${permissions.join(", ")}.`,
    ];
    if (/gemini|openai|anthropic/i.test(combinedText)) {
      parts.push(`## Detected API — Live Docs (context7)\n\nfetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent', {method:'POST', headers:{'Content-Type':'application/json','x-goog-api-key': apiKey}, body: JSON.stringify({contents:[{parts:[{text: prompt}]}]})});`);
    }
    return parts.join("\n\n---\n\n");
  });
}

function baseState(overrides: Partial<ExtensyState> = {}): ExtensyState {
  return {
    requestId: "test-request",
    user_prompt: "Build a local clipping Chrome extension.",
    subscription_tier: "free",
    planning_mode: true,
    plan_mode: false,
    planApproved: false,
    status: "running",
    author: "tester",
    tos_id: "",
    blueprint: null,
    research_context: "",
    compacted_context: "",
    devtools_summary: "",
    source_code: {},
    plan: null,
    designBrief: null,
    fileVersions: {},
    verify_retry_count: 0,
    verify_error: "",
    privacy_url: "",
    promo_brief: null,
    publishing_brief: null,
    qa_logs: [],
    legal_url: "",
    artifact_path: "",
    qa_retry_count: 0,
    error: null,
    ...overrides,
  };
}

test.afterEach(() => {
  resetLLMFactoryForTests();
  resetNiaClientForTests();
  resetSupabaseClientForTests();
  resetFetchDocPageForTests();
  resetContext7GroundingForTests();
});

test("bus resolves permission requests", async () => {
  const unsubscribe = bus.subscribeAll((event) => {
    if (event.type === "permission.requested") {
      bus.resolvePermission(event.id, "allow");
    }
  });
  const request = bus.requestPermission({
    requestId: "test-request",
    permission: "shell",
    patterns: ["npm run build"],
    timeoutMs: 1000,
  });

  try {
    assert.equal(await request, "allow");
  } finally {
    unsubscribe();
  }
});

test("permission registry denies free-tier shell and external writes", () => {
  const ctx: ToolContext = createToolContext({
    sessionId: "test-request",
    tier: "free",
    worktree: path.join(process.cwd(), "tmp-worktree"),
  });

  assert.equal(evaluatePermission(ctx, "shell", ["npm run build"]), "deny");
  assert.equal(evaluatePermission(ctx, "write", [path.join(ctx.worktree, "file.txt")]), "deny");
  assert.equal(
    evaluatePermission(ctx, "write", [path.join(ctx.worktree, ".sidekick-tmp", "file.txt")]),
    "allow"
  );
});

test("plan mode halts with a structured reviewable plan before code generation", async () => {
  installMockLLM();
  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribeAll((event) => events.push(event));

  try {
    const result = await buildGraph().invoke({
      requestId: "plan-test",
      user_prompt: "Build a local clipping extension.",
      subscription_tier: "max",
      planning_mode: true,
      plan_mode: true,
      planApproved: false,
    } as Partial<ExtensyState>);

    assert.equal(result.status, "awaiting_review");
    assert.equal(result.source_code["manifest.json"], undefined);
    assert.equal(result.plan?.steps.length, 2);
    assert.ok(events.some((event) => event.type === "plan.generated"));
  } finally {
    unsubscribe();
  }
});

test("architect and design brief nodes produce validated structured outputs", async () => {
  installMockLLM();

  const architect = await __test__.architectNode(baseState());
  assert.equal(architect.blueprint?.name, "Focus Clipper");
  assert.deepEqual(architect.blueprint?.permissions, ["activeTab", "scripting"]);

  const design = await __test__.designBriefNode(
    baseState({ subscription_tier: "pro", blueprint: architect.blueprint ?? null, research_context: "Nia context" })
  );
  assert.equal(design.designBrief?.layout, "popup");
  assert.equal(design.designBrief?.designTokens.colors.primary, "#0f766e");
});

test("context7 grounding is injected for free tier: mock is called and source_code is produced", async () => {
  installMockNia();
  installMockLLM();

  // Track whether fetchContext7Grounding was called and with what args
  let context7CalledWith: { text: string; permissions: string[] } | null = null;
  setContext7GroundingForTests(async (combinedText, permissions) => {
    context7CalledWith = { text: combinedText, permissions };
    return [
      "## Chrome Extension MV3 — Live Docs (context7)\n\nchrome.storage.local.set({key: value}).",
      "## Google Gemini API — Live Docs (context7)\n\nfetch('https://generativelanguage.googleapis.com/v1beta/...').",
    ].join("\n\n---\n\n");
  });

  const state = baseState({
    subscription_tier: "free",
    user_prompt: "Build a Gmail summarizer using Gemini AI.",
    blueprint: {
      name: "Gmail Summarizer",
      description: "Summarize Gmail threads using Gemini.",
      permissions: ["storage", "tabs"],
      host_permissions: ["https://mail.google.com/*"],
      features: [{ id: "summarize", summary: "Summarize Gmail thread using Gemini API." }],
      design_profile: "Editorial Utility",
      connectors: [],
      raw_requirements: "Summarize Gmail using Gemini.",
    },
  });

  const result = await __test__.coderNode(state);

  // context7 must have been called (not skipped)
  assert.ok(context7CalledWith !== null, "fetchContext7Grounding should be called for free-tier coder");
  // permissions from the blueprint should be forwarded
  assert.ok(
    (context7CalledWith as { permissions: string[] }).permissions.includes("storage"),
    "context7 should receive the blueprint permissions"
  );
  // user prompt should be in the combined text
  assert.ok(
    (context7CalledWith as { text: string }).text.includes("Gemini"),
    "context7 combined text should include user prompt content"
  );
  // source_code must still be produced — grounding didn't break code generation
  assert.ok(Object.keys(result.source_code ?? {}).length > 0, "coder should produce source_code");
});

test("context7 mock returns third-party API docs when prompt mentions Gemini", async () => {
  installMockContext7();
  const { fetchContext7Grounding: fetchGrounding } = await import("./context7");
  const result = await fetchGrounding("Build a Gmail summarizer using Gemini API", ["storage", "tabs"]);
  assert.ok(result.includes("Chrome Extension MV3"), "Should always include Chrome Extension docs");
  assert.ok(result.includes("generativelanguage.googleapis.com"), "Should include Gemini API docs when detected");
});

test("context7 mock returns only Chrome Extension docs when no third-party API is mentioned", async () => {
  installMockContext7();
  const { fetchContext7Grounding: fetchGrounding } = await import("./context7");
  const result = await fetchGrounding("Build a tab manager extension", ["tabs", "storage"]);
  assert.ok(result.includes("Chrome Extension MV3"), "Should always include Chrome Extension docs");
  assert.ok(!result.includes("generativelanguage.googleapis.com"), "Should not include Gemini docs for unrelated prompt");
});

test("compaction node summarizes oversized development context", async () => {
  installMockLLM();
  const result = await __test__.compactionNode(
    baseState({
      subscription_tier: "pro",
      research_context: "x".repeat(28000),
    })
  );

  assert.match(result.compacted_context ?? "", /Compact brief/);
  assert.ok((result.research_context ?? "").length <= 12000);
});

test("free-tier graph completes end-to-end and emits granular pipeline events", async () => {
  installMockLLM();
  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribeAll((event) => {
    if (!event.requestId || event.requestId === "pipeline-test") events.push(event);
  });

  try {
    const result = await buildGraph().invoke({
      requestId: "pipeline-test",
      user_prompt: "Build a local clipping Chrome extension.",
      subscription_tier: "free",
      planning_mode: false,
    } as Partial<ExtensyState>);

    assert.equal(result.error, null);
    assert.equal(result.status, "complete");
    assert.match(result.artifact_path, /^in-memory:/);
    assert.ok(result.source_code["manifest.json"]);
    assert.ok(result.source_code["EXTENSY_PROMO_BRIEF.json"]);
    assert.ok(events.some((event) => event.type === "phase.started" && event.node === "coder_node"));
    assert.ok(events.some((event) => event.type === "verify.skipped"));
    assert.ok(events.some((event) => event.type === "complete"));
  } finally {
    unsubscribe();
  }
});

test("remaining pipeline nodes return sane partial state without live services", async () => {
  installMockLLM();
  installMockNia();
  installMockSupabase();
  installMockFetch();

  const blueprint = {
    name: "Focus Clipper",
    description: "Clip useful text from the current tab.",
    permissions: ["activeTab"],
    host_permissions: [],
    features: [{ id: "clip", summary: "Clip selected text locally." }],
    raw_requirements: "Build a local-only clipping extension.",
  };
  const state = baseState({
    subscription_tier: "free",
    blueprint,
    source_code: cleanExtension,
  });

  const research = await __test__.researcherNode(baseState({ subscription_tier: "max", blueprint }));
  assert.ok((research.research_context ?? "").length > 0);

  const ui = await __test__.uiDesignerNode(state);
  assert.ok(ui.source_code?.["popup.html"]);

  const qa = await __test__.qaNode(state);
  assert.deepEqual(qa.qa_logs, []);

  const legal = await __test__.legalNode(state);
  assert.match(legal.legal_url ?? "", /^data:text\/html;base64,/);
  assert.match(legal.privacy_url ?? "", /^data:text\/html;base64,/);

  const integration = await __test__.integrationNode(state);
  assert.ok(integration.source_code?.["manifest.json"]);

  const assembled = await __test__.assemblerNode(state);
  assert.match(assembled.artifact_path ?? "", /^in-memory:/);
  assert.ok(assembled.source_code?.["EXTENSY_CHROME_WEB_STORE.json"]);
});

test("generated popup is polished and avoids generic or broken UI output", async () => {
  installMockLLM(cleanExtension);
  const result = await __test__.coderNode(baseState());

  const popupHtml = result.source_code?.["popup.html"] ?? "";
  const popupCss = result.source_code?.["popup.css"] ?? "";
  const popupJs = result.source_code?.["popup.js"] ?? "";

  assert.match(popupHtml, /data-extensy-polished="true"/);
  assert.match(popupHtml, /<button id="primary-action"/);
  assert.match(popupHtml, /aria-label="Status"/);
  assert.match(popupCss, /--surface:/);
  assert.match(popupCss, /min-height:\s*480px/);
  assert.match(popupCss, /transition:/);
  assert.match(popupJs, /chrome\.tabs\.query/);
  assert.doesNotMatch(`${popupHtml}\n${popupCss}`, /@tailwind|@apply|\btext-slate-\d|\bbg-slate-\d/);
  assert.doesNotMatch(`${popupHtml}\n${popupCss}`, /[\u{1F300}-\u{1FAFF}]/u);
});

test("coder blocks hallucinated external API endpoints", async () => {
  installMockLLM(hallucinatedExtension);
  const result = await __test__.coderNode(
    baseState({
      subscription_tier: "max",
      blueprint: {
        name: "Focus Clipper",
        description: "Clip useful text from the current tab.",
        permissions: ["activeTab"],
        host_permissions: [],
        features: [{ id: "clip", summary: "Clip selected text locally." }],
        raw_requirements: "Build a local-only clipping extension.",
      },
    })
  );

  assert.match(result.error ?? "", /Generated ungrounded external endpoint/);
  assert.match(result.error ?? "", /api\.fake-ai-summarizer\.example/);
});

test("verify node skips shell execution for free tier", async () => {
  const result = await __test__.verifyNode(
    baseState({
      subscription_tier: "free",
      source_code: {
        "popup.js": "console.log('ok');",
      },
    })
  );
  assert.equal(result.verify_error, "");
});

test("verify node runs node --check for pro tier and passes valid JS", async () => {
  const events: BusEvent[] = [];
  const unsubscribe = bus.subscribeAll((event) => {
    if (event.type === "permission.requested") bus.resolvePermission(event.id, "allow");
    events.push(event);
  });

  try {
    const result = await __test__.verifyNode(
      baseState({
        subscription_tier: "pro",
        source_code: {
          "popup.js": "document.addEventListener('DOMContentLoaded', function() { var x = 1; });",
          "manifest.json": JSON.stringify({ manifest_version: 3, name: "T", version: "1.0" }),
        },
      })
    );
    assert.equal(result.verify_error, "");
    assert.ok(!events.some((e) => e.type === "verify.skipped"), "verify.skipped must NOT fire for pro tier");
  } finally {
    unsubscribe();
  }
});

test("verify node catches syntax errors in JS for pro tier", async () => {
  const unsubscribe = bus.subscribeAll((event) => {
    if (event.type === "permission.requested") bus.resolvePermission(event.id, "allow");
  });

  try {
    const result = await __test__.verifyNode(
      baseState({
        subscription_tier: "pro",
        source_code: {
          "popup.js": "function broken( { console.log('unclosed'); }",
        },
      })
    );
    assert.ok((result.verify_error ?? "").length > 0, "verify_error should be set for invalid JS");
  } finally {
    unsubscribe();
  }
});

test("qa_router proceeds to fan_out after max retries exhausted", () => {
  const exhaustedState = baseState({
    qa_retry_count: 3,
    qa_logs: [
      {
        type: "pageerror",
        level: "error",
        message: "Uncaught ReferenceError: foo is not defined",
        captured_at: new Date().toISOString(),
      },
    ],
  });

  const route = __test__.qaRouterFn(exhaustedState);
  assert.equal(route, "fan_out_router");
});

test("qa_router retries coder when errors remain and budget is available", () => {
  const retryableState = baseState({
    qa_retry_count: 1,
    qa_logs: [
      {
        type: "console",
        level: "error",
        message: "TypeError: Cannot read properties of null",
        captured_at: new Date().toISOString(),
      },
    ],
  });

  const route = __test__.qaRouterFn(retryableState);
  assert.equal(route, "compaction_node");
});

// ---------------------------------------------------------------------------
// Agentic coder loop tests (OpenCode-style)
// ---------------------------------------------------------------------------

test("agentic coder loop: tool-calling path builds workspace incrementally", async () => {
  let step = 0;

  setLLMFactoryForTests((_options: LLMFactoryOptions): SidekickLLM => ({
    async invoke() {
      return { content: "{}" };
    },
    async invokeWithTools(_messages: ApiMessage[], tools: ToolDefinition[]): Promise<AgentTurnResult> {
      step++;

      // Step 1: write manifest.json and popup.html via tool calls
      if (step === 1 && tools.length > 0) {
        return {
          content: null,
          finishReason: "tool_calls",
          rawToolCalls: [
            {
              id: "call_manifest",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "manifest.json",
                  content: JSON.stringify({
                    manifest_version: 3,
                    name: "Focus Clipper",
                    version: "1.0.0",
                    description: "Clip text from the current tab.",
                    permissions: ["activeTab", "scripting"],
                    action: { default_popup: "popup.html" },
                  }, null, 2),
                }),
              },
            },
            {
              id: "call_popup_html",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "popup.html",
                  content: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>Focus Clipper</title><link rel="stylesheet" href="popup.css" /></head><body><main class="shell" data-extensy-polished="true"><section aria-label="Status"><strong id="runtime-status">Active</strong></section><footer><button id="primary-action" type="button"><span>Run</span></button></footer></main><script src="popup.js"></script></body></html>`,
                }),
              },
            },
          ],
        };
      }

      // Step 2: write popup.css and popup.js via tool calls
      if (step === 2 && tools.length > 0) {
        return {
          content: null,
          finishReason: "tool_calls",
          rawToolCalls: [
            {
              id: "call_css",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "popup.css",
                  content: `:root { --surface: #fff; --bg: #f5f5f4; --ink: #0f0f0f; } html, body { min-height: 480px; } button { width: 100%; } .shell { min-height: 480px; } --primary: #0f766e; transition: opacity 100ms ease;`,
                }),
              },
            },
            {
              id: "call_js",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "popup.js",
                  content: `document.addEventListener("DOMContentLoaded", () => { document.getElementById("primary-action")?.addEventListener("click", async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }); });`,
                }),
              },
            },
          ],
        };
      }

      // Final step: text output (done signal)
      return {
        content: "All extension files written. Workspace complete.",
        rawToolCalls: [],
        finishReason: "stop",
      };
    },
  }));

  const result = await __test__.coderNode(baseState({ subscription_tier: "max" }));

  assert.equal(result.error, undefined, `Unexpected error: ${result.error}`);
  assert.ok(result.source_code?.["manifest.json"], "manifest.json must be in workspace");
  assert.ok(result.source_code?.["popup.html"], "popup.html must be in workspace");
  assert.ok(result.source_code?.["popup.css"], "popup.css must be in workspace");
  assert.ok(result.source_code?.["popup.js"], "popup.js must be in workspace");
  assert.match(result.source_code?.["popup.html"] ?? "", /data-extensy-polished="true"/);
});

test("agentic coder loop: edit_file tool repairs a file in the workspace", async () => {
  let step = 0;

  const initialSource: SourceCode = {
    ...cleanExtension,
    "popup.js": `document.addEventListener("DOMContentLoaded", () => { var broken_syntax_here });`,
  };

  setLLMFactoryForTests((_options: LLMFactoryOptions): SidekickLLM => ({
    async invoke() { return { content: "{}" }; },
    async invokeWithTools(_messages: ApiMessage[], tools: ToolDefinition[]): Promise<AgentTurnResult> {
      step++;
      if (step === 1 && tools.length > 0) {
        return {
          content: null,
          finishReason: "tool_calls",
          rawToolCalls: [{
            id: "call_edit",
            type: "function",
            function: {
              name: "edit_file",
              arguments: JSON.stringify({
                path: "popup.js",
                old_string: "var broken_syntax_here",
                new_string: "const status = document.getElementById('runtime-status')",
              }),
            },
          }],
        };
      }
      return { content: "Fix applied.", rawToolCalls: [], finishReason: "stop" };
    },
  }));

  const state = baseState({
    subscription_tier: "pro",
    source_code: initialSource,
    qa_logs: [{
      type: "pageerror",
      level: "error",
      message: "SyntaxError: Unexpected identifier",
      captured_at: new Date().toISOString(),
    }],
  });

  const result = await __test__.coderNode(state);
  assert.equal(result.error, undefined);
  assert.match(result.source_code?.["popup.js"] ?? "", /const status/);
  assert.doesNotMatch(result.source_code?.["popup.js"] ?? "", /broken_syntax_here/);
});

test("agentic coder loop: list_files and read_file tools return correct workspace state", async () => {
  let callCount = 0;
  const capturedToolResults: string[] = [];

  setLLMFactoryForTests((_options: LLMFactoryOptions): SidekickLLM => ({
    async invoke() { return { content: JSON.stringify(cleanExtension) }; },
    async invokeWithTools(messages: ApiMessage[], tools: ToolDefinition[]): Promise<AgentTurnResult> {
      callCount++;

      if (callCount === 1 && tools.length > 0) {
        return {
          content: null,
          finishReason: "tool_calls",
          rawToolCalls: [
            { id: "list1", type: "function", function: { name: "list_files", arguments: "{}" } },
            { id: "write1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "popup.html", content: cleanExtension["popup.html"] }) } },
          ],
        };
      }

      if (callCount === 2 && tools.length > 0) {
        // Capture what the tool results look like in the messages
        const toolMessages = messages.filter((m): m is Extract<ApiMessage, { role: "tool" }> => m.role === "tool");
        capturedToolResults.push(...toolMessages.map((m) => m.content));

        return {
          content: null,
          finishReason: "tool_calls",
          rawToolCalls: [
            { id: "read1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "popup.html" }) } },
          ],
        };
      }

      return { content: "Done.", rawToolCalls: [], finishReason: "stop" };
    },
  }));

  await __test__.coderNode(baseState({ subscription_tier: "pro" }));

  assert.ok(callCount >= 2, "LLM must be called multiple times");
  // The list_files result should appear in later messages
  assert.ok(capturedToolResults.some((r) => r.includes("popup.html") || r === "(workspace is empty)"),
    "Tool results must reflect workspace state");
});

test("agentic coder loop: max steps safety — exits gracefully when loop runs out", async () => {
  setLLMFactoryForTests((_options: LLMFactoryOptions): SidekickLLM => ({
    async invoke() { return { content: JSON.stringify(cleanExtension) }; },
    async invokeWithTools(_messages: ApiMessage[], tools: ToolDefinition[]): Promise<AgentTurnResult> {
      if (tools.length > 0) {
        // Always return a tool call → force loop to exhaust
        return {
          content: null,
          finishReason: "tool_calls",
          rawToolCalls: [{
            id: "perpetual",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "manifest.json", content: JSON.stringify({ manifest_version: 3, name: "T", version: "1.0", permissions: [], action: { default_popup: "popup.html" } }) }),
            },
          }],
        };
      }
      // Last step (no tools): return JSON fallback
      return { content: JSON.stringify(cleanExtension), rawToolCalls: [], finishReason: "stop" };
    },
  }));

  // Free tier has 3 max steps — should not infinite loop
  const result = await __test__.coderNode(baseState({ subscription_tier: "free" }));
  // Either workspace has files (from write_file calls) or the JSON fallback was parsed
  assert.equal(result.error, undefined, `Should not error: ${result.error}`);
  assert.ok(Object.keys(result.source_code ?? {}).length > 0, "Must produce source files");
});

test("researcher node uses Nia context in synthesized research brief", async () => {
  installMockLLM();
  installMockNia();
  installMockFetch();

  const blueprint = {
    name: "Focus Clipper",
    description: "Clip useful text from the current tab.",
    permissions: ["activeTab", "scripting"],
    host_permissions: [],
    features: [{ id: "clip", summary: "Clip selected text locally." }],
    raw_requirements: "Build a local-only clipping extension.",
  };

  const result = await __test__.researcherNode(
    baseState({ subscription_tier: "max", blueprint })
  );

  assert.ok((result.research_context ?? "").length > 0, "research_context must be populated");
  assert.match(result.research_context ?? "", /Nia context/, "research_context must contain Nia data");
});
