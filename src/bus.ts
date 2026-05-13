import { EventEmitter } from "events";
import { randomUUID } from "crypto";

export type BusEvent =
  | { type: "phase.started"; requestId?: string; node: string; message: string }
  | { type: "tool.executing"; requestId?: string; tool: string; args: unknown }
  | { type: "file.written"; requestId?: string; path: string; size: number }
  | { type: "qa.diagnostic"; requestId?: string; severity: "error" | "warn" | "info"; message: string; screenshot?: string }
  | { type: "permission.requested"; requestId?: string; id: string; permission: string; patterns: string[] }
  | { type: "permission.resolved"; requestId?: string; id: string; resolution: "allow" | "deny" | "always" }
  | { type: "plan.generated"; requestId?: string; summary: string; steps: string[] }
  | { type: "context.compacted"; requestId?: string; summary: string }
  | { type: "verify.failed"; requestId?: string; error: string; retryCount: number }
  | { type: "verify.skipped"; requestId?: string; reason: string }
  | { type: "complete"; requestId?: string; artifactPath: string };

type BusCallback = (event: BusEvent) => void;
type PermissionResolution = "allow" | "deny" | "always";

interface PendingPermission {
  requestId?: string;
  resolve: (resolution: PermissionResolution) => void;
  timeout: NodeJS.Timeout;
}

const EVENT_NAME = "sidekick:event";

class SidekickBus {
  private readonly emitter = new EventEmitter();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  publish(event: BusEvent): void {
    this.emitter.emit(EVENT_NAME, event);
  }

  subscribeAll(callback: BusCallback): () => void {
    this.emitter.on(EVENT_NAME, callback);
    return () => this.emitter.off(EVENT_NAME, callback);
  }

  async requestPermission(params: {
    requestId?: string;
    permission: string;
    patterns?: string[];
    timeoutMs?: number;
  }): Promise<PermissionResolution> {
    const id = randomUUID();
    const patterns = params.patterns ?? [];

    const result = await new Promise<PermissionResolution>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingPermissions.delete(id);
        resolve("deny");
      }, params.timeoutMs ?? 5 * 60 * 1000);

      this.pendingPermissions.set(id, {
        requestId: params.requestId,
        resolve,
        timeout,
      });

      this.publish({
        type: "permission.requested",
        requestId: params.requestId,
        id,
        permission: params.permission,
        patterns,
      });
    });

    this.publish({
      type: "permission.resolved",
      requestId: params.requestId,
      id,
      resolution: result,
    });

    return result;
  }

  resolvePermission(id: string, resolution: PermissionResolution): boolean {
    const pending = this.pendingPermissions.get(id);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pendingPermissions.delete(id);
    pending.resolve(resolution);
    return true;
  }
}

export const bus = new SidekickBus();
