/**
 * llm_config.ts — Dynamic Model Configuration Factory
 *
 * Returns a configured ChatAnthropic instance appropriate for the given
 * use-case and subscription tier.  All intelligence is sourced exclusively
 * from the Anthropic API — no fallback to other providers.
 *
 * Tier → Model mapping:
 *   Max / Pro — claude-sonnet-4-5   (architect, researcher, coder)
 *   Free       — claude-haiku-4-5   (coder, legal, routing)
 *
 * The factory also wires in the NIA_API_KEY as a custom header for any
 * node that needs to pass it through to the Nia context retrieval API.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { SubscriptionTier } from "./state";

// ---------------------------------------------------------------------------
// Model identifiers
// ---------------------------------------------------------------------------

/**
 * Highest-capability Sonnet for planning, research, and Pro/Max coding.
 * Using the "latest" alias so the factory always pulls the most current
 * version without a code change.
 */
const SONNET_MODEL = "claude-sonnet-4-5";

/**
 * Cost-efficient Haiku for Free-tier generation, legal review, and routing.
 * Haiku hits the right cost/speed balance for high-frequency inference.
 */
const HAIKU_MODEL = "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// Maximum token limits
// ---------------------------------------------------------------------------
// claude-haiku-4-5 supports up to 8192 output tokens.
// claude-sonnet-4-5 supports up to 64000 but we cap at 32000 to control cost.
// Coder node needs the full budget — extensions can be 5–10 files each 50–200 lines.
const MAX_TOKENS_SONNET = 32000;
const MAX_TOKENS_HAIKU  = 8192;

// ---------------------------------------------------------------------------
// NodeRole — semantic label used to select the right model variant
// ---------------------------------------------------------------------------

/**
 * Each graph node declares its role so the factory can make the correct
 * model decision independently of the calling code.
 */
export type NodeRole =
  | "architect"    // Planning, blueprint extraction  → always Sonnet
  | "researcher"   // Nia API context retrieval        → always Sonnet
  | "coder"        // Source generation                → tier-dependent
  | "ui_designer"  // UI styling & layout              → always Sonnet
  | "legal"        // TOS generation                   → always Haiku
  | "integration"  // Third-party API wiring           → always Sonnet (Max)
  | "router";      // Lightweight routing decisions    → always Haiku

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

export interface LLMFactoryOptions {
  /** Which graph node is requesting the model */
  role: NodeRole;
  /** User's subscription tier — gating model selection for "coder" role */
  tier: SubscriptionTier;
  /**
   * When true, inject the Nia API key as an extra header on the request.
   * Only researcher_node should set this to true.
   */
  withNiaContext?: boolean;
  /** Override temperature (defaults to role-sane values) */
  temperature?: number;
}

/**
 * getLLM — primary export.
 *
 * Usage:
 *   const llm = getLLM({ role: "architect", tier: "max" });
 *   const response = await llm.invoke(messages);
 */
export function getLLM(options: LLMFactoryOptions): ChatAnthropic {
  const { role, tier, withNiaContext = false, temperature } = options;

  // ── 1. Determine model id ────────────────────────────────────────────────

  let modelId: string;
  let maxTokens: number;

  switch (role) {
    case "architect":
    case "researcher":
    case "integration":
    case "ui_designer":
      // These nodes always use the flagship Sonnet regardless of tier.
      modelId = SONNET_MODEL;
      maxTokens = MAX_TOKENS_SONNET;
      break;

    case "coder":
      // Free tier gets Haiku; Pro/Max get Sonnet for better code quality.
      if (tier === "free") {
        modelId = HAIKU_MODEL;
        maxTokens = MAX_TOKENS_HAIKU;
      } else {
        modelId = SONNET_MODEL;
        maxTokens = MAX_TOKENS_SONNET;
      }
      break;

    case "legal":
    case "router":
      // Legal and routing are cost-sensitive → Haiku across all tiers.
      modelId = HAIKU_MODEL;
      maxTokens = MAX_TOKENS_HAIKU;
      break;

    default:
      // Exhaustiveness guard — TypeScript will catch this at compile time.
      throw new Error(`[llm_config] Unknown NodeRole: ${role}`);
  }

  // ── 2. Determine temperature ─────────────────────────────────────────────

  const resolvedTemp =
    temperature ??
    ((role === "architect" || role === "legal") ? 0.2 : 0.4);
  // Lower temperature → more deterministic output for planning & legal.
  // Slightly higher → coder has latitude to be creative within constraints.

  // ── 3. Build additional headers for Nia context injection ────────────────

  /*
   * The Nia context API key is injected as an extra "X-Nia-Api-Key" header
   * on every Anthropic request.  The researcher_node uses this to include
   * retrieval-augmented context without an additional HTTP round-trip.
   *
   * Anthropic's SDK forwards `defaultHeaders` on every call, so we only
   * set it when the node opts in.
   */
  const defaultHeaders: Record<string, string> = {};

  if (withNiaContext) {
    const niaKey = process.env.NIA_API_KEY;
    if (!niaKey) {
      throw new Error(
        "[llm_config] NIA_API_KEY is not set but withNiaContext=true was requested"
      );
    }
    defaultHeaders["X-Nia-Api-Key"] = niaKey;
  }

  // ── 4. Validate ANTHROPIC_API_KEY ────────────────────────────────────────

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error("[llm_config] ANTHROPIC_API_KEY is not set in environment");
  }

  // ── 5. Construct and return the model instance ────────────────────────────

  const llm = new ChatAnthropic({
    model: modelId,
    apiKey: anthropicKey,
    maxTokens,
    temperature: resolvedTemp,
    ...(Object.keys(defaultHeaders).length > 0 && {
      clientOptions: { defaultHeaders },
    }),
  });

  console.log(
    `[llm_config] Resolved model="${modelId}" for role="${role}" tier="${tier}" temp=${resolvedTemp} niaContext=${withNiaContext}`
  );

  return llm;
}

// ---------------------------------------------------------------------------
// Convenience wrappers (optional — simplify call-sites inside graph.ts)
// ---------------------------------------------------------------------------

/** Returns the Sonnet model for architect / planning use */
export const getArchitectLLM = () =>
  getLLM({ role: "architect", tier: "max" });

/** Returns a tier-aware coder model */
export const getCoderLLM = (tier: SubscriptionTier) =>
  getLLM({ role: "coder", tier });

/** Returns the Researcher model with Nia context headers attached */
export const getResearcherLLM = () =>
  getLLM({ role: "researcher", tier: "max", withNiaContext: true });

/** Returns the UI Designer model */
export const getUIDesignerLLM = () =>
  getLLM({ role: "ui_designer", tier: "max" });

/** Returns the Haiku model for legal document generation */
export const getLegalLLM = () =>
  getLLM({ role: "legal", tier: "free" }); // tier has no effect here

/** Returns the Haiku model for lightweight routing decisions */
export const getRouterLLM = () =>
  getLLM({ role: "router", tier: "free" });

/**
 * Returns claude-haiku-4-5 for fast, cheap decomposition tasks
 * (Phase 1 & 2 of the super researcher: breaking prompts into questions
 * and mapping them to documentation URLs).
 */
export const getDecomposerLLM = () =>
  getLLM({ role: "router", tier: "free", temperature: 0.1 });
