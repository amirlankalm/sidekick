import { bus } from "../bus";
import type { ToolContext } from "./registry";

export async function parallelBatch<T>(
  ctx: ToolContext,
  calls: Array<{
    tool: string;
    args: unknown;
    run: () => Promise<T>;
  }>,
  concurrency = 5
): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = [];
  const executing = new Set<Promise<void>>();
  let index = 0;

  async function runOne(callIndex: number): Promise<void> {
    const call = calls[callIndex];
    bus.publish({
      type: "tool.executing",
      requestId: ctx.sessionId,
      tool: call.tool,
      args: call.args,
    });

    try {
      results[callIndex] = { status: "fulfilled", value: await call.run() };
    } catch (reason) {
      results[callIndex] = { status: "rejected", reason };
    }
  }

  while (index < calls.length) {
    const promise = runOne(index).finally(() => executing.delete(promise));
    executing.add(promise);
    index += 1;

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}
