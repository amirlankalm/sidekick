/**
 * state.ts — Extensy / Sidekick LangGraph State Schema
 *
 * Defines the canonical ExtensyState interface that flows through every
 * node of the graph. Each field is intentionally typed to prevent
 * accidental mutation and surface type errors early.
 *
 * Design choice: We use the @langchain/langgraph Annotation API so that
 * the state can be incrementally reduced (merged) by each node without
 * requiring a full state copy on every update.
 */

import { Annotation } from "@langchain/langgraph";

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

/**
 * Blueprint — parsed requirements extracted by the architect_node.
 * Contains everything the coder_node needs to produce deterministic output.
 */
export interface Blueprint {
  /** Human-readable name for the extension */
  name: string;
  /** One-sentence description surfaced in the Chrome Web Store */
  description: string;
  /** Chrome manifest v3 permissions the extension will request */
  permissions: string[];
  /** Any host_permissions patterns the extension needs */
  host_permissions: string[];
  /** Structured feature list so the coder can iterate over capabilities */
  features: Array<{
    id: string;
    summary: string;
    implementation_hint?: string;
  }>;
  /** Design profile the extension UI should follow (e.g., Apple Minimalist, Linear Dark, Stripe Vibrant) */
  design_profile?: string;
  /** First-party Extensy connectors required by the project */
  connectors?: Array<"supabase" | "stripe">;
  /** Raw requirements text preserved for downstream debugging */
  raw_requirements: string;
}

/**
 * SourceCode — a map of relative file paths → stringified source.
 * e.g. { "manifest.json": "{ ... }", "background.js": "..." }
 */
export type SourceCode = Record<string, string>;

/**
 * QALogEntry — one captured browser event from the Playwright harness.
 */
export interface QALogEntry {
  /** "console" | "pageerror" */
  type: "console" | "pageerror";
  /** Severity level reported by Chrome */
  level: string;
  /** Raw message text */
  message: string;
  /** ISO timestamp when the event was captured */
  captured_at: string;
}

export interface PromoSlide {
  title: string;
  body: string;
  visual_focus: string;
}

export interface PromoBrief {
  design_direction: string;
  palette: string[];
  tagline: string;
  audience: string;
  slides: PromoSlide[];
}

export interface PublishingBrief {
  listing_title: string;
  short_description: string;
  detailed_description: string;
  category_hint: string;
  permissions: string[];
  host_permissions: string[];
  legal_urls: {
    terms_of_service: string;
    privacy_policy: string;
  };
  privacy_practices_summary: string[];
  upload_readiness_checks: string[];
}

/**
 * SubscriptionTier — enforced at the initial router.
 * Free  → minimal model, no planning, no legal, basic assembler
 * Pro   → full model, planning, legal review
 * Max   → full model, planning, legal + integration + research
 */
export type SubscriptionTier = "free" | "pro" | "max";

// ---------------------------------------------------------------------------
// LangGraph Annotation (state channel definitions)
// ---------------------------------------------------------------------------

/**
 * StateAnnotation defines how each channel is reduced when multiple nodes
 * emit partial state updates within the same step.
 *
 * Convention:
 *  - Simple scalar fields use the default reducer (last-write-wins).
 *  - Array fields (qa_logs) use an append reducer so no log is lost.
 */
export const StateAnnotation = Annotation.Root({
  // ── Input ─────────────────────────────────────────────────────────────────

  /** The raw natural-language prompt from the user */
  user_prompt: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  /** Subscription tier gates model selection and node availability */
  subscription_tier: Annotation<SubscriptionTier>({
    reducer: (_, next) => next,
    default: () => "free",
  }),

  /**
   * When true the graph routes through architect_node before coding.
   * When false (or Free tier) the graph short-circuits directly to coder_node.
   */
  planning_mode: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => true,
  }),

  /** The author username passed from Extensy */
  author: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "user",
  }),

  /** Unique ID for the project TOS */
  tos_id: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  // ── Intermediate ──────────────────────────────────────────────────────────

  /**
   * Structured extension blueprint produced by architect_node.
   * Null until planning is complete.
   */
  blueprint: Annotation<Blueprint | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /**
   * Research brief merged from fetched web docs and Nia context when available.
   * Populated by the researcher_node for Pro and Max tiers.
   */
  research_context: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  /**
   * Rich diagnostics from Chrome DevTools MCP.
   * Captured during the qa_node execution.
   */
  devtools_summary: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  /**
   * Generated source files. The coder_node may rewrite this entire map
   * on each QA-triggered iteration, so we always take the latest value.
   */
  source_code: Annotation<SourceCode>({
    reducer: (_, next) => next,
    default: () => ({}),
  }),

  /** Public Privacy Policy URL generated alongside the Terms URL. */
  privacy_url: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  /** Structured promo-slide input for the Extensy promo renderer. */
  promo_brief: Annotation<PromoBrief | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /** Structured Chrome Web Store publishing metadata for the frontend. */
  publishing_brief: Annotation<PublishingBrief | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  /**
   * Accumulated QA log entries from Playwright.
   * Uses an APPEND reducer so re-runs don't erase prior error history.
   * The qa_router checks qa_logs.length > 0 to decide whether to re-code.
   */
  qa_logs: Annotation<QALogEntry[]>({
    reducer: (existing, incoming) => [...existing, ...incoming],
    default: () => [],
  }),

  /**
   * Supabase-hosted public URL for the generated Terms of Service document.
   * Populated by legal_node; required before assembler_node ships the ZIP.
   */
  legal_url: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  // ── Output ────────────────────────────────────────────────────────────────

  /**
   * Final assembled artifact path (local ZIP or remote URL).
   * Set by assembler_node as the last step of the pipeline.
   */
  artifact_path: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  /**
   * Internal iteration counter — prevents infinite QA retry loops.
   * Incremented every time qa_router sends flow back to coder_node.
   */
  qa_retry_count: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),

  // ── Error propagation ─────────────────────────────────────────────────────

  /**
   * Human-readable error message set by any node on unrecoverable failure.
   * The graph checks this field to emit a graceful error response.
   */
  error: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
});

/** Convenience type alias — the hydrated state object used inside nodes */
export type ExtensyState = typeof StateAnnotation.State;
