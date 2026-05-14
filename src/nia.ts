import { logger } from "./logger";

export interface NiaClient {
  /** Fast web search — free tier grounding, 1–10 results */
  searchWeb(query: string, numResults?: number): Promise<string>;
  /** Multi-source RAG against indexed docs — pro tier */
  searchQuery(query: string): Promise<string>;
  /** AI-agent deep research — max tier */
  searchDeep(query: string): Promise<string>;
}

const NIA_BASE_URL = "https://apigcp.trynia.ai/v2";

class NiaHttpClient implements NiaClient {
  constructor(private readonly apiKey: string) {}

  private async post(body: unknown, timeoutMs: number): Promise<Response> {
    const response = await fetch(`${NIA_BASE_URL}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Nia API error: HTTP ${response.status}${errText ? ` — ${errText.slice(0, 200)}` : ""}`
      );
    }

    return response;
  }

  private extractText(data: unknown): string {
    if (typeof data === "string") return data;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      if (typeof d.answer === "string") return d.answer;
      if (typeof d.result === "string") return d.result;
      if (typeof d.report === "string") return d.report;
      if (typeof d.content === "string") return d.content;
      if (Array.isArray(d.results)) {
        return d.results
          .map((r: unknown) => {
            if (r && typeof r === "object") {
              const res = r as Record<string, unknown>;
              const parts: string[] = [];
              if (res.title) parts.push(`**${res.title}**`);
              if (res.url) parts.push(`(${res.url})`);
              const body = res.content ?? res.snippet ?? "";
              if (body) parts.push(String(body));
              return parts.join(" ");
            }
            return String(r);
          })
          .filter(Boolean)
          .join("\n\n");
      }
    }
    return JSON.stringify(data);
  }

  async searchWeb(query: string, numResults = 5): Promise<string> {
    const response = await this.post(
      { mode: "web", query, num_results: Math.min(numResults, 10) },
      15_000
    );
    const data = (await response.json()) as unknown;
    return this.extractText(data);
  }

  async searchQuery(query: string): Promise<string> {
    const response = await this.post(
      {
        mode: "query",
        messages: [{ role: "user", content: query }],
        include_sources: true,
        max_tokens: 2000,
        fast_mode: false,
      },
      25_000
    );
    const data = (await response.json()) as unknown;
    return this.extractText(data);
  }

  async searchDeep(query: string): Promise<string> {
    const response = await this.post(
      { mode: "deep", query, output_format: "markdown", verbose: false },
      60_000
    );
    const data = (await response.json()) as unknown;
    return this.extractText(data);
  }
}

type NiaClientFactory = (() => NiaClient) | null;
let niaClientFactoryOverride: NiaClientFactory = null;

export function getNiaClient(): NiaClient {
  if (niaClientFactoryOverride) return niaClientFactoryOverride();

  const apiKey = process.env.NIA_API_KEY;
  if (!apiKey) {
    throw new Error("[nia] NIA_API_KEY must be set to use Nia search");
  }

  logger.info("Creating Nia HTTP client", { node: "nia" });
  return new NiaHttpClient(apiKey);
}

export function setNiaClientForTests(factory: () => NiaClient): void {
  niaClientFactoryOverride = factory;
}

export function resetNiaClientForTests(): void {
  niaClientFactoryOverride = null;
}
