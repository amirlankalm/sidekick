/**
 * server.ts — Sidekick HTTP API Server
 *
 * Wraps buildGraph() behind a POST /generate endpoint that streams
 * Server-Sent Events (SSE) back to the caller (Extensy or any client).
 *
 * SSE event types emitted:
 *   phase    — { node: string, message: string }   current pipeline phase
 *   files    — Record<string, string>               final source file map
 *   legal    — { url: string }                      TOS URL (Pro only)
 *   done     — { artifact_path: string }            pipeline complete
 *   error    — { message: string }                  unrecoverable error
 *
 * Works both locally (ts-node src/server.ts) and on Vercel
 * (exported as the default handler via serverless-http).
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import { buildGraph } from "./graph";
import type { ExtensyState } from "./state";

const app = express();
app.use(express.json());

// ── CORS: allow Extensy frontend and sidekick.extensy.dev ─────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin ?? "";
  // Allow localhost, all extensy.app subdomains, and Vercel preview URLs
  const isAllowed =
    origin === "http://localhost:3000" ||
    origin === "http://localhost:3001" ||
    origin.endsWith(".extensy.app") ||
    origin === "https://extensy.app" ||
    origin.endsWith(".vercel.app") ||   // Vercel preview deployments
    process.env.NODE_ENV !== "production";

  if (isAllowed) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "sidekick-engine" });
});

// ── POST /generate — main pipeline endpoint ───────────────────────────────
app.post("/generate", async (req: Request, res: Response) => {
  const {
    prompt,
    subscription_tier = "free",
    planning_mode = true,
  } = req.body as {
    prompt?: string;
    subscription_tier?: "free" | "pro" | "max";
    planning_mode?: boolean;
  };

  if (!prompt?.trim()) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  // ── Set up SSE headers ────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  /** Sends one SSE frame to the client */
  const emit = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Map LangGraph node names → human-readable phase messages for the UI
  const PHASE_MESSAGES: Record<string, string> = {
    architect_node:    "Analyzing your prompt...",
    researcher_node:   "Fetching Chrome Extension docs...",
    coder_node:        "Writing extension code...",
    qa_node:           "Running QA tests in Chromium...",
    fan_out_router:    "Preparing final steps...",
    legal_node:        "Generating Terms of Service...",
    integration_node:  "Wiring third-party integrations...",
    assembler_node:    "Packaging your extension...",
  };

  try {
    const graph = buildGraph();

    // Stream node-level events by subscribing to graph events
    const stream = graph.streamEvents(
      {
        user_prompt: prompt,
        subscription_tier,
        planning_mode,
      } as Partial<ExtensyState>,
      { version: "v2" }
    );

    let finalState: ExtensyState | null = null;

    for await (const event of stream) {
      // ── Emit phase updates per node entry ──────────────────────────────
      if (event.event === "on_chain_start" && event.name in PHASE_MESSAGES) {
        emit("phase", {
          node: event.name,
          message: PHASE_MESSAGES[event.name] ?? event.name,
        });
      }

      // ── Capture final state when graph completes ────────────────────────
      if (event.event === "on_chain_end" && event.name === "LangGraph") {
        finalState = event.data?.output as ExtensyState;
      }
    }

    if (!finalState) {
      emit("error", { message: "Pipeline completed but produced no output" });
      res.end();
      return;
    }

    if (finalState.error) {
      emit("error", { message: finalState.error });
      res.end();
      return;
    }

    // ── Emit generated files ────────────────────────────────────────────────
    emit("files", finalState.source_code);

    // ── Emit legal URL if generated ─────────────────────────────────────────
    if (finalState.legal_url) {
      emit("legal", { url: finalState.legal_url });
    }

    // ── Emit done ───────────────────────────────────────────────────────────
    emit("done", {
      artifact_path: finalState.artifact_path,
      qa_retries: finalState.qa_retry_count,
    });

  } catch (err) {
    console.error("[server] Unhandled pipeline error:", err);
    emit("error", {
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    res.end();
  }
});

// ── Local dev: start listening ────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 3001);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 Sidekick API server running on http://localhost:${PORT}`);
    console.log(`   POST http://localhost:${PORT}/generate`);
    console.log(`   GET  http://localhost:${PORT}/health\n`);
  });
}

// ── Vercel serverless export ──────────────────────────────────────────────
export default app;
