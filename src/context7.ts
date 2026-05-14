import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTEXT7_BASE = "https://context7.com/api/v1";

/**
 * Always-on library: every Chrome extension uses the Chrome Extension MV3 APIs.
 * 11,034 snippets, High reputation — the best grounding source for content scripts,
 * service workers, chrome.storage, chrome.tabs, messaging, permissions, and CSP.
 */
const CHROME_EXT_LIBRARY_ID = "websites/developer_chrome_extensions";

/**
 * Maps detected third-party API names to the library name context7 understands.
 * Used to resolve a library ID at runtime via the search API.
 */
const THIRD_PARTY_DETECTORS: Array<[RegExp, string]> = [
  [/gemini|google.*generative|generativelanguage/i, "Google Gemini API"],
  [/openai|gpt-?[34]|chatgpt/i,                     "OpenAI API"],
  [/anthropic|claude api/i,                          "Anthropic Claude API"],
  [/google maps|maps javascript api|geocod/i,        "Google Maps JavaScript API"],
  [/youtube data api|youtube.*api/i,                 "YouTube Data API"],
  [/google calendar|calendar api/i,                  "Google Calendar API"],
  [/slack web api/i,                                 "Slack Web API"],
  [/discord.*api|discord\.js/i,                      "Discord API"],
  [/\bnotion api\b/i,                                "Notion API"],
  [/\bairtable\b/i,                                  "Airtable API"],
  [/github.*api|octokit/i,                           "GitHub REST API"],
  [/twitter.*api|x\.com.*api/i,                      "Twitter API v2"],
  [/spotify.*api/i,                                  "Spotify Web API"],
  [/openweather|weather api/i,                       "OpenWeatherMap API"],
  [/\bsupabase\b/i,                                  "Supabase"],
  [/\bstripe\b/i,                                    "Stripe API"],
];

// ---------------------------------------------------------------------------
// Testable override layer (mirrors the pattern in nia.ts)
// ---------------------------------------------------------------------------

export type Context7GroundingFn = (combinedText: string, permissions: string[]) => Promise<string>;
type OverrideFn = Context7GroundingFn | null;
let overrideFn: OverrideFn = null;

export function setContext7GroundingForTests(fn: Context7GroundingFn): void {
  overrideFn = fn;
}

export function resetContext7GroundingForTests(): void {
  overrideFn = null;
}

// ---------------------------------------------------------------------------
// Library detection
// ---------------------------------------------------------------------------

/**
 * Scan free text for a known third-party API pattern.
 * Returns the human-readable library name or null.
 */
export function detectContext7Library(text: string): string | null {
  for (const [pattern, name] of THIRD_PARTY_DETECTORS) {
    if (pattern.test(text)) return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface Context7SearchResult {
  id: string;
  name?: string;
  trust_score?: number;
  total_snippets?: number;
}
interface Context7SearchResponse {
  results?: Context7SearchResult[];
}

/** Simple in-process cache: library name → resolved context7 ID */
const resolveCache = new Map<string, string | null>();

async function resolveLibraryId(libraryName: string): Promise<string | null> {
  if (resolveCache.has(libraryName)) return resolveCache.get(libraryName)!;

  const url = `${CONTEXT7_BASE}/search?query=${encodeURIComponent(libraryName)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`context7 search HTTP ${res.status}`);

  const data = (await res.json()) as Context7SearchResponse;
  const results = (data.results ?? []).sort((a, b) => {
    const sA = (a.trust_score ?? 0) * 100 + (a.total_snippets ?? 0);
    const sB = (b.trust_score ?? 0) * 100 + (b.total_snippets ?? 0);
    return sB - sA;
  });

  const id = results[0]?.id ?? null;
  resolveCache.set(libraryName, id);
  return id;
}

async function fetchLibraryDocs(
  libraryId: string,
  topic: string,
  maxTokens = 4000,
  maxChars = 3200
): Promise<string> {
  const params = new URLSearchParams({ tokens: String(maxTokens), topic });
  // libraryId may arrive with or without a leading slash
  const url = `${CONTEXT7_BASE}/${libraryId.replace(/^\//, "")}?${params}`;
  const res = await fetch(url, {
    headers: { Accept: "text/plain, application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`context7 docs HTTP ${res.status}`);
  const text = await res.text();
  return text.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch context7 grounding for a generation run.
 *
 * Always fetches Chrome Extension MV3 docs (relevant to EVERY extension).
 * Conditionally fetches third-party API docs when one is detected in the prompt.
 *
 * Both fetches run in parallel. Failures are silent — the pipeline degrades
 * gracefully and continues with Nia + web-fetch context.
 *
 * @param combinedText  User prompt + feature summaries joined as a single string
 * @param permissions   Declared manifest permissions (used to target the Chrome doc topic)
 */
export async function fetchContext7Grounding(
  combinedText: string,
  permissions: string[]
): Promise<string> {
  if (overrideFn) return overrideFn(combinedText, permissions);

  const log = logger.child({ module: "context7" });

  const chromeExtTopic = [
    "MV3 content scripts service worker messaging permissions",
    permissions.slice(0, 4).map(p => `chrome.${p}`).join(" "),
    "chrome.storage chrome.tabs chrome.scripting executeScript",
  ].join(" ");

  const thirdPartyName = detectContext7Library(combinedText);

  // Run both lookups concurrently — Chrome ext docs always, third-party only when detected
  const [chromeResult, thirdPartyResult] = await Promise.allSettled([
    fetchLibraryDocs(CHROME_EXT_LIBRARY_ID, chromeExtTopic).then(docs => ({
      label: "Chrome Extension MV3",
      docs,
    })),
    thirdPartyName
      ? resolveLibraryId(thirdPartyName)
          .then(id => {
            if (!id) return null;
            const topic = `authentication API key fetch endpoint JavaScript ${thirdPartyName}`;
            return fetchLibraryDocs(id, topic).then(docs => ({ label: thirdPartyName, docs }));
          })
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const parts: string[] = [];

  if (chromeResult.status === "fulfilled" && chromeResult.value.docs.trim()) {
    log.info("context7 Chrome Extension docs fetched", { length: chromeResult.value.docs.length });
    parts.push(`## Chrome Extension MV3 — Live Docs (context7)\n\n${chromeResult.value.docs}`);
  } else if (chromeResult.status === "rejected") {
    log.warn("context7 Chrome Extension docs failed", { error: String(chromeResult.reason) });
  }

  if (thirdPartyResult.status === "fulfilled" && thirdPartyResult.value?.docs.trim()) {
    const { label, docs } = thirdPartyResult.value;
    log.info("context7 third-party API docs fetched", { library: label, length: docs.length });
    parts.push(`## ${label} — Live API Docs (context7)\n\n${docs}`);
  }

  return parts.join("\n\n---\n\n");
}
