/**
 * server.ts — Sidekick HTTP API Server
 *
 * Wraps buildGraph() behind a POST /generate endpoint that streams
 * Server-Sent Events (SSE) back to Extensy's frontend.
 *
 * Security layers:
 *   1. CORS allowlist — only Extensy origins can make cross-origin requests
 *   2. Rate limiting  — 60 req/min global; 5 req/min on /generate per IP
 *   3. Auth           — Supabase JWT verification via Authorization header
 *                       (REQUIRE_AUTH=true enforces it; false = warn only)
 *   4. Input validation — prompt required, tier enum-checked, fields clamped
 *   5. Request ID      — every request gets a UUID for full log correlation
 *
 * SSE event types emitted:
 *   phase      — { node: string, message: string }
 *   files      — Record<string, string>
 *   legal      — { url: string, terms_url?: string, privacy_url?: string }
 *   promo      — PromoBrief
 *   publishing — PublishingBrief
 *   done       — { artifact_path: string, qa_retries: number }
 *   error      — { message: string }
 */

import "dotenv/config";
import { randomUUID } from "crypto";
import express, { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import { buildGraph } from "./graph";
import { logger } from "./logger";
import type { ExtensyState } from "./state";
import { bus } from "./bus";

const app = express();

// Trust Vercel's proxy so X-Forwarded-For is used for real client IPs.
// Without this, express-rate-limit sees 127.0.0.1 for every request and
// throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set("trust proxy", 1);

app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = new Set([
  "https://extensy.app",
  "https://www.extensy.app",
  "https://extensy.dev",
  "https://www.extensy.dev",
  "https://sidekick.extensy.dev",
  "http://localhost:3000",
  "http://localhost:3001",
]);
const ALLOWED_ORIGIN_SUFFIXES = [".extensy.app", ".extensy.dev", ".vercel.app"];

function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (process.env.NODE_ENV !== "production") return true;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-Id");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Global limit — protects all endpoints from general abuse */
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests — slow down" },
  handler(req, res, next, options) {
    logger.warn("Global rate limit exceeded", { ip: req.ip, path: req.path });
    res.status(options.statusCode).json(options.message);
  },
});

/** Generate-specific limit — heavy LLM + Playwright endpoint */
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many generation requests — please wait before trying again" },
  handler(req, res, next, options) {
    logger.warn("/generate rate limit exceeded", { ip: req.ip });
    res.status(options.statusCode).json(options.message);
  },
});

app.use(globalLimiter);

// ---------------------------------------------------------------------------
// Auth — Supabase JWT verification
// ---------------------------------------------------------------------------

const REQUIRE_AUTH = process.env.REQUIRE_AUTH === "true";

interface AuthResult {
  userId: string | null;
  authenticated: boolean;
}

async function verifySupabaseToken(token: string): Promise<AuthResult> {
  const url  = process.env.SUPABASE_URL;
  const key  = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return { userId: null, authenticated: false };

  try {
    const supabase = createClient(url, key);
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return { userId: null, authenticated: false };
    return { userId: data.user.id, authenticated: true };
  } catch {
    return { userId: null, authenticated: false };
  }
}

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "sidekick-engine" });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "sidekick-engine",
    uptime_seconds: Math.round(process.uptime()),
  });
});

// ---------------------------------------------------------------------------
// POST /generate — main pipeline endpoint
// ---------------------------------------------------------------------------

const VALID_TIERS = new Set(["free", "pro", "max"]);

const PHASE_MESSAGES: Record<string, string> = {
  plan_node:        "Drafting read-only plan...",
  architect_node:   "Analyzing your prompt...",
  researcher_node:  "Fetching Chrome Extension docs...",
  compaction_node:  "Compacting context...",
  design_brief_node:"Creating design brief...",
  coder_node:       "Writing extension code...",
  ui_designer_node: "Polishing popup UI...",
  verify_node:      "Running static verification...",
  qa_node:          "Running QA tests in Chromium...",
  fan_out_router:   "Preparing final steps...",
  legal_node:       "Generating legal documents...",
  integration_node: "Wiring third-party integrations...",
  assembler_node:   "Packaging your extension...",
};

const approvedPlans = new Set<string>();

app.post("/respond-permission", async (req: Request, res: Response) => {
  const { id, resolution } = req.body as {
    id?: string;
    resolution?: "allow" | "deny" | "always";
  };

  if (!id || !resolution || !["allow", "deny", "always"].includes(resolution)) {
    res.status(400).json({ error: "id and resolution=allow|deny|always are required" });
    return;
  }

  const resolved = bus.resolvePermission(id, resolution);
  if (!resolved) {
    res.status(404).json({ error: "permission request not found or already resolved" });
    return;
  }

  res.json({ ok: true });
});

app.post("/approve-plan", async (req: Request, res: Response) => {
  const { requestId } = req.body as { requestId?: string };
  if (!requestId) {
    res.status(400).json({ error: "requestId is required" });
    return;
  }

  approvedPlans.add(requestId);
  res.json({
    ok: true,
    requestId,
    resume: "Call /generate again with the same requestId and planApproved=true to continue.",
  });
});

app.post("/generate", generateLimiter, async (req: Request, res: Response) => {
  const requestId = randomUUID();
  const log = logger.child({ requestId });

  // ── Auth ─────────────────────────────────────────────────────────────────
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  let userId: string | null = null;

  if (token) {
    const auth = await verifySupabaseToken(token);
    if (!auth.authenticated) {
      log.warn("Invalid Supabase token provided");
      if (REQUIRE_AUTH) {
        res.status(401).json({ error: "Invalid or expired authentication token" });
        return;
      }
    } else {
      userId = auth.userId;
      log.info("Request authenticated", { userId });
    }
  } else {
    log.warn("Unauthenticated /generate request", { ip: req.ip });
    if (REQUIRE_AUTH) {
      res.status(401).json({ error: "Authorization header with Bearer token is required" });
      return;
    }
  }

  // ── Input validation ──────────────────────────────────────────────────────
  const {
    prompt,
    subscription_tier = "free",
    planning_mode = true,
    plan_mode = false,
    planApproved = false,
    author = "user",
    tos_id = "",
    requestId: requestedRequestId,
  } = req.body as {
    prompt?: string;
    subscription_tier?: string;
    planning_mode?: boolean;
    plan_mode?: boolean;
    planApproved?: boolean;
    author?: string;
    tos_id?: string;
    requestId?: string;
  };

  if (!prompt?.trim()) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  if (!VALID_TIERS.has(subscription_tier)) {
    res.status(400).json({ error: "subscription_tier must be free, pro, or max" });
    return;
  }

  const safeTier = subscription_tier as "free" | "pro" | "max";
  const effectiveRequestId = requestedRequestId?.trim() || requestId;
  const approved = planApproved || approvedPlans.has(effectiveRequestId);

  log.info("/generate request received", {
    userId,
    tier: safeTier,
    promptLength: prompt.trim().length,
  });

  // ── SSE setup ─────────────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", effectiveRequestId);
  res.flushHeaders();

  const emit = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const unsubscribe = bus.subscribeAll((event) => {
    if (event.requestId && event.requestId !== effectiveRequestId) return;
    emit(event.type, event);
  });

  try {
    const graph = buildGraph();

    const stream = graph.streamEvents(
      {
        requestId: effectiveRequestId,
        user_prompt: prompt.trim(),
        subscription_tier: safeTier,
        planning_mode,
        plan_mode,
        planApproved: approved,
        author: author.trim().slice(0, 120),
        tos_id: tos_id.trim().slice(0, 120),
      } as Partial<ExtensyState>,
      { version: "v2" }
    );

    let finalState: ExtensyState | null = null;

    for await (const event of stream) {
      if (event.event === "on_chain_start" && event.name in PHASE_MESSAGES) {
        emit("phase", {
          type: "phase.started",
          node: event.name,
          message: PHASE_MESSAGES[event.name] ?? event.name,
        });
      }

      if (event.event === "on_chain_end" && event.name === "LangGraph") {
        finalState = event.data?.output as ExtensyState;
      }
    }

    if (!finalState) {
      emit("error", { message: "Pipeline completed but produced no output" });
      res.end();
      return;
    }

    if (finalState.status === "awaiting_review") {
      emit("awaiting_review", {
        type: "plan.awaiting_review",
        requestId: effectiveRequestId,
        plan: finalState.plan,
      });
      res.end();
      return;
    }

    if (finalState.error) {
      log.error("Pipeline completed with error", { error: finalState.error });
      emit("error", { message: finalState.error });
      res.end();
      return;
    }

    emit("files", finalState.source_code);

    if (finalState.legal_url || finalState.privacy_url) {
      emit("legal", {
        url: finalState.legal_url,
        terms_url: finalState.legal_url,
        privacy_url: finalState.privacy_url,
      });
    }

    if (finalState.promo_brief) emit("promo", finalState.promo_brief);
    if (finalState.publishing_brief) emit("publishing", finalState.publishing_brief);

    emit("done", {
      artifact_path: finalState.artifact_path,
      qa_retries: finalState.qa_retry_count,
    });

    log.info("/generate completed", {
      userId,
      tier: safeTier,
      qaRetries: finalState.qa_retry_count,
      fileCount: Object.keys(finalState.source_code).length,
    });
  } catch (err) {
    log.error("Unhandled pipeline error", { error: String(err) });
    emit("error", {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    unsubscribe();
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Local dev server
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3001);

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info("Sidekick API server started", {
      port: PORT,
      requireAuth: REQUIRE_AUTH,
      env: process.env.NODE_ENV ?? "development",
    });
  });
}

export default app;
