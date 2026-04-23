/**
 * llm_config.ts — Dynamic Model Configuration Factory
 *
 * Sidekick currently routes all inference through Groq's OpenAI-compatible
 * chat completions API using Meta Llama 4 Scout. The node-role factory keeps
 * the rest of the graph isolated from provider-specific details.
 */

import type { BaseMessage } from "@langchain/core/messages";
import type { SubscriptionTier } from "./state";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const SCOUT_MODEL = process.env.GROQ_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_TOKENS_SCOUT = 8192;

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

class GroqChatModel implements SidekickLLM {
  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      maxTokens: number;
      temperature: number;
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

    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
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
      throw new Error(
        `[llm_config] Groq request failed (${response.status}): ${data?.error?.message ?? "unknown error"}`
      );
    }

    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error("[llm_config] Groq returned an empty completion");
    }

    return { content };
  }
}

function serializeMessage(message: BaseMessage): InvocationMessage {
  const role = resolveRole(message);
  const content = extractMessageContent(message);

  return {
    role,
    content,
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
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("[llm_config] GROQ_API_KEY is not set in environment");
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
    ((role === "architect" || role === "legal" || role === "router") ? 0.2 : 0.35);

  console.log(
    `[llm_config] Provider=groq model="${SCOUT_MODEL}" role="${role}" temp=${resolvedTemp} niaContext=${withNiaContext}`
  );

  return new GroqChatModel({
    apiKey,
    model: SCOUT_MODEL,
    maxTokens: MAX_TOKENS_SCOUT,
    temperature: resolvedTemp,
    ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
  });
}

export const getArchitectLLM = () =>
  getLLM({ role: "architect", tier: "max" });

export const getCoderLLM = (tier: SubscriptionTier) =>
  getLLM({ role: "coder", tier });

export const getResearcherLLM = () =>
  getLLM({ role: "researcher", tier: "max", withNiaContext: true });

export const getUIDesignerLLM = () =>
  getLLM({ role: "ui_designer", tier: "max" });

export const getLegalLLM = () =>
  getLLM({ role: "legal", tier: "free" });

export const getRouterLLM = () =>
  getLLM({ role: "router", tier: "free" });

export const getDecomposerLLM = () =>
  getLLM({ role: "router", tier: "free", temperature: 0.1 });
