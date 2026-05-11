/**
 * llm_config.ts — Dynamic Model Configuration Factory
 *
 * Sidekick routes all inference through Google Gemini's OpenAI-compatible
 * chat completions API. The node-role factory keeps the rest of the graph
 * isolated from provider-specific details.
 */

import type { BaseMessage } from "@langchain/core/messages";
import type { SubscriptionTier } from "./state";
import { logger } from "./logger";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_FLASH_MODEL = process.env.GEMINI_FLASH_MODEL ?? "gemini-2.0-flash-latest";
const GEMINI_PRO_MODEL   = process.env.GEMINI_PRO_MODEL   ?? "gemini-2.5-pro-latest";

function resolveModel(tier: SubscriptionTier): string {
  return tier === "max" ? GEMINI_PRO_MODEL : GEMINI_FLASH_MODEL;
}

const MAX_TOKENS_BY_ROLE: Record<NodeRole, number> = {
  architect:   2048,
  researcher:  4096,
  coder:       8192,
  ui_designer: 8192,
  legal:       4096,
  integration: 4096,
  router:      1536,
};

export type NodeRole =
  | "architect"
  | "researcher"
  | "coder"
  | "ui_designer"
  | "legal"
  | "integration"
  | "router";

export interface LLMFactoryOptions {
  role: NodeRole;
  tier: SubscriptionTier;
  withNiaContext?: boolean;
  temperature?: number;
}

interface InvocationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface InvocationResult {
  content: string;
}

export interface SidekickLLM {
  invoke(messages: BaseMessage[]): Promise<InvocationResult>;
}

class GeminiChatModel implements SidekickLLM {
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      maxTokens: number;
      temperature: number;
      role: NodeRole;
      defaultHeaders?: Record<string, string>;
    }
  ) {}

  async invoke(messages: BaseMessage[]): Promise<InvocationResult> {
    const payload = {
      model: this.options.model,
      messages: messages.map(serializeMessage),
      temperature: this.options.temperature,
      max_tokens: this.options.maxTokens,
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          ...(this.options.defaultHeaders ?? {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(45_000),
      });

      const data = (await response.json().catch(() => null)) as
        | {
            error?: { message?: string };
            choices?: Array<{ message?: { content?: string | null } }>;
          }
        | null;

      if (!response.ok) {
        if (response.status === 429 && attempt < 3) {
          const retryAfter = response.headers.get("retry-after");
          const waitMs = resolveRetryDelayMs(retryAfter, data?.error?.message, attempt);
          logger.warn("Gemini rate limited — retrying", {
            node: this.options.role,
            attempt,
            retryAfterSec: Math.round(waitMs / 1000),
          });
          await sleep(waitMs);
          continue;
        }

        throw new Error(
          `Gemini request failed (${response.status}): ${data?.error?.message ?? "unknown error"}`
        );
      }

      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error("Gemini returned an empty completion");
      }

      return { content };
    }

    throw new Error("Gemini request failed after 3 retries");
  }
}

function resolveRetryDelayMs(
  retryAfter: string | null,
  message: string | undefined,
  attempt: number
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 500;
  }

  const messageDelay = message?.match(/try again in ([\d.]+)s/i)?.[1];
  if (messageDelay) {
    const seconds = Number(messageDelay);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 500;
  }

  return attempt * 4000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeMessage(message: BaseMessage): InvocationMessage {
  return {
    role: resolveRole(message),
    content: extractMessageContent(message),
  };
}

function resolveRole(message: BaseMessage): InvocationMessage["role"] {
  const maybeType =
    typeof (message as { getType?: () => string }).getType === "function"
      ? (message as { getType: () => string }).getType()
      : typeof (message as { _getType?: () => string })._getType === "function"
        ? (message as { _getType: () => string })._getType()
        : "human";

  if (maybeType === "system") return "system";
  if (maybeType === "ai") return "assistant";
  return "user";
}

function extractMessageContent(message: BaseMessage): string {
  const raw = message.content;
  if (typeof raw === "string") return raw;

  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return JSON.stringify(raw);
}

export function getLLM(options: LLMFactoryOptions): SidekickLLM {
  const { role, withNiaContext = false, temperature } = options;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("[llm_config] GEMINI_API_KEY is not set in environment");
  }

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

  const resolvedTemp =
    temperature ??
    (role === "architect" || role === "legal" || role === "router" ? 0.2 : 0.35);

  const model = resolveModel(options.tier);

  logger.info("LLM created", {
    node: role,
    model,
    tier: options.tier,
    temperature: resolvedTemp,
    maxTokens: MAX_TOKENS_BY_ROLE[role],
    niaContext: withNiaContext,
  });

  return new GeminiChatModel({
    apiKey,
    model,
    maxTokens: MAX_TOKENS_BY_ROLE[role],
    temperature: resolvedTemp,
    role,
    ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
  });
}

export const getArchitectLLM  = () => getLLM({ role: "architect",   tier: "max" });
export const getCoderLLM      = (tier: SubscriptionTier) => getLLM({ role: "coder", tier });
export const getResearcherLLM = () => getLLM({ role: "researcher",  tier: "max", withNiaContext: true });
export const getUIDesignerLLM = () => getLLM({ role: "ui_designer", tier: "max" });
export const getLegalLLM      = () => getLLM({ role: "legal",       tier: "free" });
export const getRouterLLM     = () => getLLM({ role: "router",      tier: "free" });
export const getDecomposerLLM = () => getLLM({ role: "router",      tier: "free", temperature: 0.1 });
