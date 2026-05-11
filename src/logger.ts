/**
 * logger.ts — Structured JSON logger for Sidekick
 *
 * Outputs JSON lines in production (machine-readable for Railway/Vercel log drains).
 * Outputs readable colorized lines in development.
 *
 * Usage:
 *   import { logger } from "./logger";
 *   logger.info("Server started", { port: 3001 });
 *
 *   // Scoped logger for a request/node:
 *   const log = logger.child({ requestId, node: "coder_node" });
 *   log.warn("Partial parse fallback triggered", { filesRecovered: 3 });
 */

const IS_PROD = process.env.NODE_ENV === "production";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  node?: string;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

const DEV_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info:  "\x1b[36m", // cyan
  warn:  "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

function emit(level: LogLevel, message: string, context: LogContext): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[MIN_LEVEL]) return;

  const ts = Date.now();

  if (IS_PROD) {
    const entry = JSON.stringify({ ts, level, msg: message, ...context });
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(entry + "\n");
    return;
  }

  const time = new Date(ts).toISOString().slice(11, 23);
  const color = DEV_COLORS[level];
  const tag = `${color}[${level.toUpperCase().padEnd(5)}]${RESET}`;
  const ctx = Object.keys(context).length > 0
    ? ` \x1b[90m${JSON.stringify(context)}${RESET}`
    : "";

  const line = `\x1b[90m${time}${RESET} ${tag} ${message}${ctx}`;
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function makeLogger(base: LogContext = {}) {
  return {
    debug: (msg: string, ctx?: LogContext) => emit("debug", msg, { ...base, ...ctx }),
    info:  (msg: string, ctx?: LogContext) => emit("info",  msg, { ...base, ...ctx }),
    warn:  (msg: string, ctx?: LogContext) => emit("warn",  msg, { ...base, ...ctx }),
    error: (msg: string, ctx?: LogContext) => emit("error", msg, { ...base, ...ctx }),
    child: (extra: LogContext) => makeLogger({ ...base, ...extra }),
  };
}

export const logger = makeLogger();
export type Logger = ReturnType<typeof makeLogger>;
