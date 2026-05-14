/**
 * llm_config.ts — Dynamic Model Configuration Factory
 *
 * Sidekick routes all inference through Google Gemini's OpenAI-compatible
 * chat completions API. The node-role factory keeps the rest of the graph
 * isolated from provider-specific details.
 */

import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { SubscriptionTier } from "./state";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// OpenAI-compatible tool schema types (used by invokeWithTools / agentic loop)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required: string[];
    };
  };
}

export interface ApiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ApiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ApiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentTurnResult {
  content: string | null;
  rawToolCalls: ApiToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "unknown";
}

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_FLASH_MODEL = process.env.GEMINI_FLASH_MODEL ?? "gemini-2.5-flash";
const GEMINI_PRO_MODEL   = process.env.GEMINI_PRO_MODEL   ?? "gemini-2.5-pro";

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
  temperature?: number;
}

interface InvocationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface InvocationResult {
  content: string;
}

/**
 * OpenCode-style system discipline injected into all LLM nodes.
 * Derived from opencode:packages/opencode/src/session/prompt/anthropic.txt
 * and the Gemini variant at prompt/gemini.txt.
 */
export const OPENCODE_SYSTEM_DISCIPLINE = `You are an autonomous coding agent. Follow these rules at all times:

WORKFLOW (mirrors OpenCode build-agent protocol):
1. UNDERSTAND: Read existing files before modifying. Use read_file / list_files to understand current state.
2. PLAN: Reason briefly about architecture before writing. Consider which Chrome APIs and files are needed.
3. IMPLEMENT: Write files incrementally using write_file. One file at a time. Start with manifest.json.
4. VERIFY: After writing .js files, run bash_check to catch syntax errors early.
5. REVIEW: Use read_file to confirm a written file looks correct. Use edit_file for surgical fixes.

EXECUTION RULES:
- Execute independent tool calls in parallel in a single turn (e.g. write popup.html and popup.css simultaneously).
- Never explain code unless explicitly asked. After writing or editing, just proceed.
- Do not use emojis unless the user explicitly requests them.
- Run bash_check after writing every .js file (when shell access is available).
- Never commit to git or write to .env files unless explicitly asked.
- Mimic existing file conventions (naming, imports, quote style) when editing.
- If you cannot do something, state it in one sentence and offer an alternative.

OUTPUT FORMAT:
- When tools are available: use write_file / edit_file / read_file / list_files / bash_check / grep_workspace.
- Use grep_workspace to locate a symbol or selector before editing — never read a whole file just to find one line.
- When no tools are available (final output step): output the complete source map as a single JSON object where each key is a relative file path and each value is the raw file content. No markdown fences around the JSON. No prose.`;

export interface SidekickLLM {
  invoke(messages: BaseMessage[]): Promise<InvocationResult>;
  /**
   * OpenCode-style tool-calling turn.  Accepts messages in native OpenAI
   * format (including tool-result messages) and returns the raw tool-call
   * list alongside any text content, so the caller can run the agentic loop.
   */
  invokeWithTools(messages: ApiMessage[], tools: ToolDefinition[]): Promise<AgentTurnResult>;
}

type LLMFactoryOverride = ((options: LLMFactoryOptions) => SidekickLLM) | null;

let llmFactoryOverride: LLMFactoryOverride = null;

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
      messages: applySystemDiscipline(messages).map(serializeMessage),
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
        signal: AbortSignal.timeout(90_000),
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

  async invokeWithTools(
    messages: ApiMessage[],
    tools: ToolDefinition[]
  ): Promise<AgentTurnResult> {
    const payload: Record<string, unknown> = {
      model: this.options.model,
      messages,
      temperature: this.options.temperature,
      max_tokens: this.options.maxTokens,
    };
    if (tools.length > 0) {
      payload.tools = tools;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          ...(this.options.defaultHeaders ?? {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90_000),
      });

      const data = (await response.json().catch(() => null)) as
        | {
            error?: { message?: string };
            choices?: Array<{
              finish_reason?: string;
              message?: {
                content?: string | null;
                tool_calls?: ApiToolCall[];
              };
            }>;
          }
        | null;

      if (!response.ok) {
        if (response.status === 429 && attempt < 3) {
          const retryAfter = response.headers.get("retry-after");
          const waitMs = resolveRetryDelayMs(retryAfter, data?.error?.message, attempt);
          logger.warn("Gemini rate limited (invokeWithTools) — retrying", {
            node: this.options.role,
            attempt,
            retryAfterSec: Math.round(waitMs / 1000),
          });
          await sleep(waitMs);
          continue;
        }
        throw new Error(
          `Gemini invokeWithTools failed (${response.status}): ${data?.error?.message ?? "unknown error"}`
        );
      }

      const choice = data?.choices?.[0];
      const msg = choice?.message;
      const finishReason = choice?.finish_reason ?? "unknown";
      const rawToolCalls: ApiToolCall[] = msg?.tool_calls ?? [];
      const content = msg?.content?.trim() ?? null;

      logger.info("Gemini invokeWithTools turn", {
        node: this.options.role,
        finishReason,
        toolCallCount: rawToolCalls.length,
        hasContent: content !== null,
      });

      return {
        content,
        rawToolCalls,
        finishReason:
          finishReason === "tool_calls"
            ? "tool_calls"
            : finishReason === "stop"
              ? "stop"
              : finishReason === "length"
                ? "length"
                : "unknown",
      };
    }

    throw new Error("Gemini invokeWithTools failed after 3 retries");
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

function applySystemDiscipline(messages: BaseMessage[]): BaseMessage[] {
  if (messages.some((message) => resolveRole(message) === "system")) {
    return messages.map((message) => {
      if (resolveRole(message) !== "system") return message;
      const content = `${extractMessageContent(message)}\n\n${OPENCODE_SYSTEM_DISCIPLINE}`;
      return new SystemMessage(content);
    });
  }

  return [
    new SystemMessage(OPENCODE_SYSTEM_DISCIPLINE),
    ...messages,
  ];
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
  if (llmFactoryOverride) return llmFactoryOverride(options);

  const { role, temperature } = options;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("[llm_config] GEMINI_API_KEY is not set in environment");
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
  });

  return new GeminiChatModel({
    apiKey,
    model,
    maxTokens: MAX_TOKENS_BY_ROLE[role],
    temperature: resolvedTemp,
    role,
  });
}

export const getArchitectLLM  = () => getLLM({ role: "architect",   tier: "max" });
export const getCoderLLM      = (tier: SubscriptionTier) => getLLM({ role: "coder", tier });
export const getResearcherLLM = () => getLLM({ role: "researcher",  tier: "max" });
export const getUIDesignerLLM = () => getLLM({ role: "ui_designer", tier: "max" });
export const getLegalLLM      = () => getLLM({ role: "legal",       tier: "free" });
export const getRouterLLM     = () => getLLM({ role: "router",      tier: "free" });
export const getDecomposerLLM = () => getLLM({ role: "router",      tier: "free", temperature: 0.1 });

export function setLLMFactoryForTests(factory: (options: LLMFactoryOptions) => SidekickLLM): void {
  llmFactoryOverride = factory;
}

export function resetLLMFactoryForTests(): void {
  llmFactoryOverride = null;
}
