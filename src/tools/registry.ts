import path from "path";
import type { SubscriptionTier } from "../state";
import { bus } from "../bus";

export interface ToolContext {
  sessionId: string;
  tier: SubscriptionTier;
  worktree: string;
  directory: string;
  abort: AbortSignal;
  ask(permission: string, patterns?: string[]): Promise<"allow" | "deny" | "always">;
}

export type ToolPermission = "read" | "write" | "shell" | "network" | "browser";
export type PermissionDecision = "allow" | "deny" | "ask";

export function createToolContext(params: {
  sessionId: string;
  tier: SubscriptionTier;
  worktree: string;
  directory?: string;
  abort?: AbortSignal;
}): ToolContext {
  return {
    sessionId: params.sessionId,
    tier: params.tier,
    worktree: path.resolve(params.worktree),
    directory: path.resolve(params.directory ?? params.worktree),
    abort: params.abort ?? new AbortController().signal,
    ask(permission, patterns) {
      return bus.requestPermission({
        requestId: params.sessionId,
        permission,
        patterns,
      });
    },
  };
}

export function evaluatePermission(
  ctx: ToolContext,
  permission: ToolPermission,
  patterns: string[] = []
): PermissionDecision {
  if (ctx.tier === "max") {
    return isDestructive(permission, patterns) ? "ask" : "allow";
  }

  if (ctx.tier === "pro") {
    if (permission === "shell") return "ask";
    if (permission === "write" && patterns.some((pattern) => !isInsideWorktree(ctx, pattern))) {
      return "ask";
    }
    return "allow";
  }

  if (permission === "shell" || permission === "browser") return "deny";
  if (permission === "network") return "allow";
  if (permission === "write") {
    return patterns.every((pattern) => isFreeWritablePath(ctx, pattern)) ? "allow" : "deny";
  }
  return "allow";
}

export async function assertPermission(
  ctx: ToolContext,
  permission: ToolPermission,
  patterns: string[] = []
): Promise<void> {
  const decision = evaluatePermission(ctx, permission, patterns);
  if (decision === "allow") return;
  if (decision === "deny") {
    throw new Error(`Permission denied for ${permission}: ${patterns.join(", ") || "*"}`);
  }

  const resolution = await ctx.ask(permission, patterns);
  if (resolution === "deny") {
    throw new Error(`Permission denied for ${permission}: ${patterns.join(", ") || "*"}`);
  }
}

function isFreeWritablePath(ctx: ToolContext, target: string): boolean {
  const absolute = path.resolve(ctx.directory, target);
  const freeRoot = path.join(ctx.worktree, ".sidekick-tmp");
  return absolute === freeRoot || absolute.startsWith(`${freeRoot}${path.sep}`);
}

function isInsideWorktree(ctx: ToolContext, target: string): boolean {
  const absolute = path.resolve(ctx.directory, target);
  return absolute === ctx.worktree || absolute.startsWith(`${ctx.worktree}${path.sep}`);
}

function isDestructive(permission: ToolPermission, patterns: string[]): boolean {
  if (permission !== "shell" && permission !== "write") return false;
  return patterns.some((pattern) =>
    /\b(rm|rmdir|mv|chmod|chown|git\s+reset|git\s+clean|drop|truncate)\b/i.test(pattern)
  );
}
