import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import type { BaseMessage } from "@langchain/core/messages";
import { bus, type BusEvent } from "./bus";
import { buildGraph, __test__ } from "./graph";
import {
  resetLLMFactoryForTests,
  setLLMFactoryForTests,
  type LLMFactoryOptions,
  type SidekickLLM,
} from "./llm_config";
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
                text: "#0f0f0f",
              },
              borderRadius: "8px",
              fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
              spacingUnit: "4px",
            },
            componentHierarchy: [
              { name: "PopupRoot", children: ["Header", "MainContent", "Footer"] },
            ],
            layout: "popup",
            iconSet: "inline-svg",
            responsive: true,
            darkMode: "media-query",
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
      if (options.role === "researcher") return { content: "Nia context: local-only MV3 patterns." };
      return { content: JSON.stringify(source) };
    },
  }));
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
    baseState({ blueprint: architect.blueprint ?? null, research_context: "Nia context" })
  );
  assert.equal(design.designBrief?.layout, "popup");
  assert.equal(design.designBrief?.designTokens.colors.primary, "#0f766e");
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
