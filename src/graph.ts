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
  type PromoBrief,
  type PublishingBrief,
} from "./state";
import {
  getArchitectLLM,
  getCoderLLM,
  getResearcherLLM,
  getLegalLLM,
  getUIDesignerLLM,
  getDecomposerLLM,
} from "./llm_config";
import { runDevToolsDiagnostics } from "./devtools_mcp";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max number of QA→coder retry cycles before aborting (prevents inf. loops) */
const MAX_QA_RETRIES = 3;

/** Directory where Playwright loads the extension under test */
const TMP_EXT_DIR = path.join(os.tmpdir(), "sidekick", "extension");

/** Where the assembled ZIP is written (local dev only; skipped on Vercel) */
const OUTPUT_DIR = path.join(os.tmpdir(), "sidekick", "output");
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
type ConnectorKind = "supabase" | "stripe";
type LegalDocKind = "terms-of-service" | "privacy-policy";

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
  await fs.mkdir(TMP_EXT_DIR, { recursive: true });

  for (const [relativePath, content] of Object.entries(sourceCode)) {
    const normalizedPath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const absolute = path.resolve(TMP_EXT_DIR, normalizedPath);
    if (!absolute.startsWith(`${TMP_EXT_DIR}${path.sep}`) && absolute !== TMP_EXT_DIR) {
      throw new Error(`[graph] Refusing to write file outside extension root: ${relativePath}`);
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, "utf-8");
  }

  console.log(
    `[graph] Wrote ${Object.keys(sourceCode).length} file(s) to ${TMP_EXT_DIR}`
  );
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

function getDesignDirection(profile?: string): string {
  const normalized = (profile || "").toLowerCase();
  if (normalized.includes("editorial")) return "Editorial Utility";
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
  if (state.subscription_tier === "max" || state.subscription_tier === "pro") {
    // Pro & Max both get deep web + Nia research context before coding.
    // Max additionally gets a full Synthesis pass (Phase 5).
    console.log(`[router/research] ${state.subscription_tier} tier → researcher_node`);
    return "researcher_node";
  }
  console.log("[router/research] Free tier → coder_node (no research)");
  return "coder_node";
}

// ---------------------------------------------------------------------------
// Helper: fetch and strip a documentation web page to plain text
// ---------------------------------------------------------------------------

/**
 * Fetches a public URL, strips all HTML/script/style tags, collapses whitespace,
 * and truncates to `maxChars` to avoid blowing the context window.
 * Uses AbortSignal.timeout so it never hangs the pipeline.
 */
async function fetchDocPage(url: string, maxChars = 12000): Promise<string> {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" || !ALLOWED_DOC_HOSTS.has(parsedUrl.hostname)) {
      console.warn(`[researcher/fetch] Blocked unsupported documentation URL: ${url}`);
      return "";
    }

    const res = await fetch(url, {
      signal: AbortSignal.timeout(9000),
      headers: { "User-Agent": "Extensy-Sidekick-Researcher/1.0" },
    });
    if (!res.ok) {
      console.warn(`[researcher/fetch] ${url} returned HTTP ${res.status} — skipping`);
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
    console.log(`[researcher/fetch] ✓ ${url} → ${stripped.length} chars`);
    return `--- Source: ${url} ---\n${stripped}`;
  } catch (err) {
    console.warn(`[researcher/fetch] ✗ ${url} failed: ${String(err)}`);
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
  console.log(`[researcher_node] Starting deep research (tier=${state.subscription_tier})…`);

  const decomposerLLM  = getDecomposerLLM();   // claude-haiku-4-5 — fast & cheap
  const synthesizerLLM = getArchitectLLM();     // claude-sonnet-4-5 for synthesis

  const blueprintJson = state.blueprint
    ? JSON.stringify(state.blueprint, null, 2)
    : `User prompt: ${state.user_prompt}`;

  const designProfile = state.blueprint?.design_profile || "Editorial Utility";

  // ── Phase 1: Decompose → Research Questions ─────────────────────────────
  console.log("[researcher_node] Phase 1 — Decomposing into research questions…");

  const p1Response = await decomposerLLM.invoke([
    new SystemMessage(`You are a Chrome Extension research planner.
Given a blueprint, output a NUMBERED LIST (1-5 items, plain text) of the most specific, targeted research questions that need to be answered to implement this extension correctly.
Focus on: Chrome MV3 APIs, third-party API endpoints, auth flows, and CSP constraints.
Return ONLY the numbered list, no prose, no headers.`),
    new HumanMessage(`Generate targeted research questions for this extension blueprint:\n\n${blueprintJson}`),
  ]);

  const researchQuestions = typeof p1Response.content === "string"
    ? p1Response.content
    : JSON.stringify(p1Response.content);
  console.log(`[researcher_node] Phase 1 ✓ — ${researchQuestions.split("\n").length} questions`);

  // ── Phase 2: Map Questions → Documentation URLs ──────────────────────────
  console.log("[researcher_node] Phase 2 — Mapping questions to documentation URLs…");

  const p2Response = await decomposerLLM.invoke([
    new SystemMessage(`You are a Chrome Extension documentation specialist.
Given a list of research questions, output a PLAIN LIST of 3-8 authoritative, publicly accessible documentation URLs that directly answer those questions.
Prefer: developer.chrome.com, official API docs (docs.github.com, developers.notion.com, etc.), MDN.
Return ONLY one URL per line — no prose, no numbering, no markdown.`),
    new HumanMessage(`Find documentation URLs for these research questions:\n\n${researchQuestions}`),
  ]);

  const urlBlock = typeof p2Response.content === "string"
    ? p2Response.content
    : JSON.stringify(p2Response.content);

  const docUrls = urlBlock
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
      })
      .slice(0, 8); // cap at 8 pages

  console.log(`[researcher_node] Phase 2 ✓ — ${docUrls.length} URLs identified: ${docUrls.join(", ")}`);

  // ── Phase 3: Parallel Web Fetch ──────────────────────────────────────────
  console.log(`[researcher_node] Phase 3 — Fetching ${docUrls.length} documentation pages…`);

  const fetchResults = await Promise.allSettled(
    docUrls.map(url => fetchDocPage(url))
  );

  const webContent = fetchResults
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && r.value.length > 0)
    .map(r => r.value)
    .join("\n\n");

  console.log(`[researcher_node] Phase 3 ✓ — Retrieved ${webContent.length} total chars from web`);

  // ── Phase 4: Nia Semantic Recall ─────────────────────────────────────────
  console.log("[researcher_node] Phase 4 — Pulling context from Nia…");

  let niaContext = "(Nia unavailable for this run)";
  try {
    const researcherLLM = getResearcherLLM(); // claude-sonnet-4-5 + NIA_API_KEY
    const p4Response = await researcherLLM.invoke([
      new SystemMessage(`You are a Nia context retrieval agent.
Using your Nia knowledge base, surface ONLY what is directly relevant to the request.
Do not invent or generalize. Return exact design tokens, code patterns, and API snippets found in Nia.
Return plain text grouped by clear section headers.`),
      new HumanMessage(
        `Retrieve from Nia:\n` +
        `1. "Chrome Extension Manifest V3 best practices and API patterns"\n` +
        `2. "${designProfile} design profile: exact Tailwind tokens, padding scale, colors, border radius"\n` +
        `3. "Google Font imports, inline SVG usage, and micro-interaction CSS for premium extensions"\n\n` +
        `Blueprint context:\n${blueprintJson}`
      ),
    ]);

    niaContext = typeof p4Response.content === "string"
      ? p4Response.content
      : JSON.stringify(p4Response.content);

    console.log(`[researcher_node] Phase 4 ✓ — Nia returned ${niaContext.length} chars`);
  } catch (err) {
    console.warn(`[researcher_node] Phase 4 skipped — Nia unavailable: ${String(err)}`);
  }

  // ── Phase 5: Synthesize (Max-tier only) ──────────────────────────────────
  if (state.subscription_tier !== "max") {
    // Pro tier: pass raw web content + Nia data directly to coder as research context
    const rawContext = [
      "## Research Questions\n" + researchQuestions,
      "## Documentation URLs Consulted\n" + docUrls.join("\n"),
      "## Web Documentation Content\n" + (webContent || "(no pages fetched)"),
      "## Nia Design & API Context\n" + niaContext,
    ].join("\n\n---\n\n");

    console.log(`[researcher_node] Phase 5 skipped (Pro tier) — passing raw context (${rawContext.length} chars)`);
    return { research_context: rawContext };
  }

  console.log("[researcher_node] Phase 5 — Synthesizing research brief (Max tier)…");

  const p5Response = await synthesizerLLM.invoke([
    new SystemMessage(`You are a senior Chrome Extension research analyst.
Synthesize the provided web documentation content and Nia design context into a clean, structured research brief.
This brief will be consumed by a coder and a UI designer in separate nodes, so be precise and actionable.

Structure your output with these exact sections:
## Chrome API Patterns & MV3 Rules
## Third-Party API Integration Guide
## CSP & Security Constraints
## UI Design System Tokens (from Nia)
## Implementation Gotchas

Be specific. Include real endpoint paths, exact CSS classes, real permission names. No filler prose.`),
    new HumanMessage(
      `## Research Questions\n${researchQuestions}\n\n` +
      `## Web Documentation Fetched\n${webContent || "(no pages fetched)"}\n\n` +
      `## Nia Design & API Context\n${niaContext}`
    ),
  ]);

  const synthesizedBrief = typeof p5Response.content === "string"
    ? p5Response.content
    : JSON.stringify(p5Response.content);

  console.log(`[researcher_node] Phase 5 ✓ — Synthesized brief: ${synthesizedBrief.length} chars`);
  return { research_context: synthesizedBrief };
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
  const isRetry = state.qa_logs.length > 0 || state.devtools_summary.length > 0;
  const connectors = detectRequiredConnectors(state);
  console.log(
    `[coder_node] Generating code (retry=${isRetry}, attempt=${state.qa_retry_count + 1})…`
  );

  const llm = getCoderLLM(state.subscription_tier);

  const systemPrompt = `You are an expert Chrome Extension engineer.
Produce a complete, production-ready Manifest V3 extension.

Output ONLY a JSON object where each key is a relative file path and each value is
the stringified file content.  Example:
{
  "manifest.json": "{\n  \\"manifest_version\\": 3,\n  ... \n}",
  "background.js": "// service worker ...\n\nconsole.log('test');",
  "popup.html": "<!DOCTYPE html>\n<html>\n...",
  "popup.js": "document.addEventListener('DOMContentLoaded', () => {\n  ...\n});"
}

Rules:
- Always include manifest.json with manifest_version 3
- Never use eval() or inline scripts (CSP compliance)
- Service workers must follow MV3 patterns (no persistent background pages)
- All external requests must use host_permissions declared in the manifest
- If auth, database, or payments are part of the product, wire the provided Extensy connector modules instead of inventing raw provider glue
- Maintain pristine, highly readable code formatting with correct indentation and newlines in your stringified content. Never minify the code!
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

  if (connectors.length > 0) {
    parts.push(buildConnectorPrompt(connectors));
  }

  if (isRetry) {
    const errorSummary = state.qa_logs
      .map((l) => `[${l.type}/${l.level}] ${l.message}`)
      .join("\n");
    
    let retryContext = `## ⚠️ QA Errors — Fix These (attempt ${state.qa_retry_count + 1}/${MAX_QA_RETRIES})\n${errorSummary}`;
    
    if (state.devtools_summary) {
      retryContext += `\n\n## 🔍 Deep Browser Diagnostics (DevTools MCP)\n${state.devtools_summary}`;
    }
    
    parts.push(retryContext);
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
    
    // Auto-format any generated JSON files
    for (const [filename, content] of Object.entries(sourceCode)) {
      if (filename.endsWith('.json')) {
        try { sourceCode[filename] = JSON.stringify(JSON.parse(content), null, 2); }
        catch {}
      }
    }
  } catch (err) {
    // ── Fallback: try to extract individual file entries via regex ─────────
    // This rescues truncated responses where the final }" is cut off.
    console.warn("[coder_node] Full JSON parse failed, attempting partial extraction:", String(err));

    const partialFiles: SourceCode = {};
    // Match "filename": "content" pairs — content may span multiple lines
    const filePattern = /"([^"]+\.(?:js|ts|html|css|json|md|txt|svg|png))"\s*:\s*"((?:[^"\\]|\\.)*)"/gs;
    let match: RegExpExecArray | null;
    while ((match = filePattern.exec(raw)) !== null) {
      const [, filename, content] = match;
      partialFiles[filename] = content.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    }

    if (Object.keys(partialFiles).length > 0) {
      console.warn(`[coder_node] Recovered ${Object.keys(partialFiles).length} file(s) from partial response`);
      sourceCode = partialFiles;
    } else {
      return {
        error: `coder_node: Failed to parse generated source — ${String(err)}`,
      };
    }
  }


  console.log(
    `[coder_node] Generated ${Object.keys(sourceCode).length} file(s): ${Object.keys(sourceCode).join(", ")}`
  );

  const connectorFiles = buildConnectorFiles(connectors);
  const withConnectorFiles = {
    ...sourceCode,
    ...connectorFiles,
  };
  const patchedSourceCode = patchManifestForConnectors(withConnectorFiles, connectors);

  return {
    source_code: patchedSourceCode,
    // Reset qa_logs so only the *current* run's errors flow into the next retry.
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
  console.log("[ui_designer_node] Enhancing extension UI/UX design…");

  const llm = getUIDesignerLLM();

  const codeSnapshot = Object.entries(state.source_code)
    .filter(([filePath]) => filePath.endsWith(".html") || filePath.endsWith(".css") || filePath.endsWith(".js"))
    .map(([file, content]) => `// === ${file} ===\n${content}`)
    .join("\n\n");

  const systemPrompt = `You are an elite Chrome Extension UI designer.
Your task is to completely eliminate generic 'vibecoded' UI and apply a highly structured, premium aesthetic based on the provided design profile and research context.

Strict Design Rules:
1. DESIGN PROFILE: You must strictly apply the "${state.blueprint?.design_profile || 'Editorial Utility'}" design profile.
2. RESEARCH CONTEXT: Use the exact color codes, Tailwind padding tokens, and border radii provided in the Nia Design Inspiration context below. Do not guess arbitrary values.
3. EDITORIAL UTILITY DIRECTION: Use a warm off-white canvas, deep ink text, one restrained accent, left-aligned hierarchy, mono metadata labels, and asymmetrical composition. Avoid SaaS dashboard tropes, glow effects, centered hero blocks, purple/blue AI gradients, and card spam.
4. FOUNDATION: Prefer a distinctive editorial sans such as Outfit, Manrope, or Plus Jakarta Sans paired with a mono for labels. Use high-quality inline SVGs configured with \`currentColor\`—do NOT use emojis for icons.
5. MICRO-INTERACTIONS: Keep motion minimal and tactile. Use \`transition-all duration-200 ease-out active:scale-[0.98]\` for buttons and restrained hover shifts instead of loud animation.
6. SPACING: Use a strict 4-point spacing scale. Favor \`p-4\`, \`p-6\`, \`gap-3\`, \`gap-4\`, and strong whitespace rhythm. Not every section should be boxed.

Return ONLY a JSON object where each key is a relative file path (same as provided) and each value is the strictly formatted stringified file content.
Example: { "popup.html": "...", "popup.css": "..." }
Do not remove functionality or data bindings. Only ENHANCE the styles and structure.
Output ONLY the JSON map — no markdown fences, no prose.`;

  const userMessageContent = state.research_context 
    ? `Nia Design Inspiration Context:\n${state.research_context}\n\nEnhance the UI of the following extension code:\n\n${codeSnapshot}`
    : `Enhance the UI of the following extension code:\n\n${codeSnapshot}`;

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
    const cleaned = raw
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/```\s*$/m, "")
      .trim();
    if (cleaned !== "{}") {
      uiFiles = JSON.parse(cleaned) as SourceCode;
    }
  } catch (err) {
    console.warn("[ui_designer_node] Could not parse UI designer output. Attempting partial extraction.", err);
    const partialFiles: SourceCode = {};
    const filePattern = /"([^"]+\.(?:js|ts|html|css|json|md|txt|svg|png))"\s*:\s*"((?:[^"\\]|\\.)*)"/gs;
    let match: RegExpExecArray | null;
    while ((match = filePattern.exec(raw)) !== null) {
      const [, filename, content] = match;
      partialFiles[filename] = content.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\").replace(/\\"/g, '"');
    }
    if (Object.keys(partialFiles).length > 0) {
      uiFiles = partialFiles;
    }
  }

  console.log(
    `[ui_designer_node] Enhanced ${Object.keys(uiFiles).length} UI file(s): ${Object.keys(uiFiles).join(", ")}`
  );

  return {
    source_code: { ...state.source_code, ...uiFiles },
  };
}

// ---------------------------------------------------------------------------
// Router: ui_designer_router
// ---------------------------------------------------------------------------

function uiDesignerRouterFn(
  state: ExtensyState
): "ui_designer_node" | "qa_node" {
  if (state.subscription_tier === "free") {
    console.log("[router/ui_designer] Free tier → qa_node directly");
    return "qa_node";
  }
  console.log("[router/ui_designer] Pro/Max tier → ui_designer_node");
  return "ui_designer_node";
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
  if (state.subscription_tier === "free") {
    console.log("[qa_node] Skipping QA for free tier to optimize generation speed.");
    return { qa_logs: [] };
  }

  console.log("[qa_node] Writing extension to disk and launching Playwright…");

  await writeExtensionToDisk(state.source_code);

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
      context = await playwrightChromium.launchPersistentContext(userDataDir, {
        headless: true,
        executablePath,
        args: [...sparticuzChromium.args, ...extensionArgs],
      });
    } else {
      context = await playwrightChromium.launchPersistentContext(userDataDir, {
        headless: true,
        args: extensionArgs,
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
    console.log("[qa_node] 🔍 Running Chrome DevTools MCP diagnostics…");
    const diagnostics = await runDevToolsDiagnostics(targetUrl, debugPort);
    
    if (diagnostics.consoleLogs.length > 0) logs.push(...diagnostics.consoleLogs);
    if (diagnostics.networkErrors.length > 0) logs.push(...diagnostics.networkErrors);
    if (diagnostics.domIssues.length > 0) logs.push(...diagnostics.domIssues);

    // Store diagnostics in local variables to return after cleanup
    const devtools_summary = diagnostics.rawSummary;

    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });

    console.log(`[qa_node] QA complete. Captured ${logs.length} issue(s).`);
    return { 
      qa_logs: logs,
      devtools_summary
    };
  } catch (err) {
    console.error("[qa_node] Playwright launch failed:", err);
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
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
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
 * Generates Terms of Service + Privacy Policy documents tailored to the extension,
 * uploads them to Supabase Storage, and returns public URLs.
 */
async function legalNode(
  state: ExtensyState
): Promise<Partial<ExtensyState>> {
  console.log("[legal_node] Generating legal documents…");

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
    console.error("[legal_node] Unexpected Supabase error:", err);
    legalUrl = `data:text/html;base64,${Buffer.from(termsHtml).toString("base64")}`;
    privacyUrl = `data:text/html;base64,${Buffer.from(privacyHtml).toString("base64")}`;
  }

  console.log(`[legal_node] Terms URL: ${legalUrl}`);
  console.log(`[legal_node] Privacy URL: ${privacyUrl}`);
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
  console.log("[integration_node] Auditing and wiring third-party integrations…");

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
  console.log("[assembler_node] Assembling final Chrome Extension ZIP…");

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

  return {
    artifact_path: artifactPath,
    source_code: sourceCode,
    promo_brief: promoBrief,
    publishing_brief: publishingBrief,
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
  graph.addNode("architect_node", architectNode);
  graph.addNode("researcher_node", researcherNode);
  graph.addNode("coder_node", coderNode);
  graph.addNode("ui_designer_node", uiDesignerNode);
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

  // ── coder_node → ui_designer_router ──────────────────────────────────────
  g.addConditionalEdges("coder_node", uiDesignerRouterFn);

  // ── ui_designer_node → qa_node ───────────────────────────────────────────
  g.addEdge("ui_designer_node", "qa_node");

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
