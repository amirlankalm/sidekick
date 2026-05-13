import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import type { BrowserContext, chromium as ChromiumType } from "playwright-core";
import { bus } from "../bus";
import { assertPermission, type ToolContext } from "./registry";

export async function writeTextFile(
  ctx: ToolContext,
  filePath: string,
  content: string | Buffer
): Promise<void> {
  const absolute = path.resolve(ctx.directory, filePath);
  await assertPermission(ctx, "write", [absolute]);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  bus.publish({
    type: "file.written",
    requestId: ctx.sessionId,
    path: absolute,
    size: Buffer.byteLength(content),
  });
}

export async function mkdir(ctx: ToolContext, dirPath: string): Promise<void> {
  const absolute = path.resolve(ctx.directory, dirPath);
  await assertPermission(ctx, "write", [absolute]);
  await fs.mkdir(absolute, { recursive: true });
}

export async function rm(ctx: ToolContext, targetPath: string): Promise<void> {
  const absolute = path.resolve(ctx.directory, targetPath);
  await assertPermission(ctx, "write", [`rm ${absolute}`]);
  await fs.rm(absolute, { recursive: true, force: true });
}

export async function runCommand(
  ctx: ToolContext,
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cwd = path.resolve(options.cwd ?? ctx.directory);
  await assertPermission(ctx, "shell", [[command, ...args].join(" ")]);
  bus.publish({
    type: "tool.executing",
    requestId: ctx.sessionId,
    tool: "shell",
    args: { command, args, cwd },
  });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      env: process.env,
      signal: ctx.abort,
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 120_000);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

export async function launchPersistentContext(
  ctx: ToolContext,
  chromium: typeof ChromiumType,
  userDataDir: string,
  options: NonNullable<Parameters<typeof ChromiumType.launchPersistentContext>[1]>
): Promise<BrowserContext> {
  await assertPermission(ctx, "browser", ["playwright.chromium.launchPersistentContext"]);
  bus.publish({
    type: "tool.executing",
    requestId: ctx.sessionId,
    tool: "playwright.chromium.launchPersistentContext",
    args: {
      userDataDir,
      headless: options.headless,
      args: options.args,
    },
  });
  return chromium.launchPersistentContext(userDataDir, options);
}

export async function editFile(
  ctx: ToolContext,
  filePath: string,
  oldString: string,
  newString: string
): Promise<void> {
  const absolute = path.resolve(ctx.directory, filePath);
  await assertPermission(ctx, "write", [absolute]);
  const current = await fs.readFile(absolute, "utf-8");
  const next = current.includes(oldString)
    ? current.replace(oldString, newString)
    : current.replace(normalizeWhitespace(oldString), normalizeWhitespace(newString));

  if (next === current) {
    throw new Error(`editFile could not find target string in ${filePath}`);
  }

  await writeTextFile(ctx, absolute, next);
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
