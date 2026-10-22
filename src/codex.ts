import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ExitError, isSystemError } from "./errors.ts";
import { codexHome, commandLine, type Host } from "./host.ts";
import { floorDivide, splitLines } from "./python-format.ts";
import {
  dumps,
  get,
  isPythonInt,
  isRecord,
  type Json,
  numericValue,
  or,
  parseJson,
  toFloat,
  toInt,
  truthy,
} from "./python-json.ts";
import { parseIso } from "./time-format.ts";
import type { Banked, Credit, UsageWindow, Via } from "./usage.ts";
import { VERSION } from "./version.ts";

/** A Codex window; one whose snapshot has already reset restarts from zero. */
export function codexWindow(
  used: number,
  lengthS: number,
  resetsAt: number,
  observedAt: number,
  now: number,
): UsageWindow {
  const name = lengthS < 86400 ? `${Math.floor(lengthS / 3600)}h` : `${Math.floor(lengthS / 86400)}d`;
  if (resetsAt < now) {
    // the snapshot's window has already reset: usage restarts from zero
    const periods = Math.max(1, Math.trunc(floorDivide(now - resetsAt, lengthS)) + 1);
    return {
      name,
      used: 0,
      lengthS,
      resetsAt: lengthS ? resetsAt + lengthS * periods : resetsAt,
      observedAt,
    };
  }
  return { name, used, lengthS, resetsAt, observedAt };
}

/** `glob(root/**\/rollout-*.jsonl, recursive=True)`: hidden names skipped, linked directories followed. */
function rolloutFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) {
        continue;
      }
      const path = join(dir, name);
      if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        out.push(path);
      }
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (isDirectory) {
        walk(path);
      }
    }
  };
  try {
    if (statSync(root).isDirectory()) {
      walk(root);
    }
  } catch {
    // no sessions yet
  }
  return out;
}

const mtime = (path: string) => statSync(path).mtimeMs / 1000;

/** The windows of the newest rate-limit snapshot in the Codex session logs. */
export function codexWindows(host: Host): UsageWindow[] {
  const files = rolloutFiles(join(codexHome(host.env), "sessions"))
    .map((path) => ({ path, mtime: mtime(path) }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20);
  let best: { t: number; limits: Record<string, unknown> } | null = null;
  for (const { path } of files) {
    let lines: string[];
    try {
      lines = splitLines(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    for (const line of lines.reverse()) {
      if (!line.includes('"rate_limits"')) {
        continue;
      }
      let event: unknown;
      try {
        event = parseJson(line);
      } catch {
        continue;
      }
      const payload = get(event, "payload");
      const limits = or(truthy(payload) ? get(payload, "rate_limits") : null, () =>
        get(event, "rate_limits"),
      );
      if (!isRecord(limits)) {
        continue;
      }
      const when = get(event, "timestamp");
      let t: number;
      if (truthy(when)) {
        if (typeof when !== "string") {
          throw new TypeError("timestamp is not a string");
        }
        t = parseIso(when.replaceAll("Z", "+00:00"));
      } else {
        t = mtime(path);
      }
      if (best === null || t > best.t) {
        best = { t, limits };
      }
      break;
    }
  }
  if (best === null) {
    throw new ExitError("agent-pace: no Codex rate-limit snapshot found (run one Codex turn first)");
  }
  const { t: observed, limits } = best;
  const out: UsageWindow[] = [];
  for (const slot of ["secondary", "primary"]) {
    const w = get(limits, slot);
    if (!truthy(w) || get(w, "used_percent") === null) {
      continue;
    }
    const lengthS = toInt(or(get(w, "window_minutes"), () => 0)) * 60;
    let resets: number;
    if (truthy(get(w, "resets_at"))) {
      resets = toFloat(get(w, "resets_at"));
    } else if (get(w, "resets_in_seconds") !== null) {
      resets = observed + toFloat(get(w, "resets_in_seconds"));
    } else {
      continue;
    }
    out.push(codexWindow(toFloat(get(w, "used_percent")), lengthS, resets, observed, host.now()));
  }
  if (out.length === 0) {
    throw new ExitError("agent-pace: the Codex snapshot has no usage windows");
  }
  return out.sort((a, b) => a.lengthS - b.lengthS);
}

/** Lines from a process's stdout, each awaited until a deadline. */
class LineReader {
  private readonly lines: (string | null)[] = [];
  private wake: (() => void) | null = null;
  private readonly reader: {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    cancel(): Promise<void>;
  };

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
    void this.pump();
  }

  /**
   * Stops reading. A grandchild of the server can hold its stdout open after the server is
   * gone; Python left its reader thread behind, and this lets go of the pipe the same way.
   */
  close(): void {
    this.reader.cancel().catch(() => {});
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { done, value: chunk } = await this.reader.read();
        if (done || chunk === undefined) {
          break;
        }
        pending += decoder.decode(chunk, { stream: true });
        let end = pending.indexOf("\n");
        while (end >= 0) {
          this.push(pending.slice(0, end + 1));
          pending = pending.slice(end + 1);
          end = pending.indexOf("\n");
        }
      }
    } catch {
      // the stream broke: what was read stands
    }
    if (pending) {
      this.push(pending);
    }
    this.push(null); // the server exited
  }

  private push(line: string | null): void {
    this.lines.push(line);
    this.wake?.();
  }

  /** The next line, null at the end of output, or "timeout" if none came within `seconds`. */
  async next(seconds: number): Promise<string | null | "timeout"> {
    const deadline = performance.now() + seconds * 1000;
    while (this.lines.length === 0) {
      const left = deadline - performance.now();
      if (left <= 0) {
        return "timeout";
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
    return this.lines.shift() ?? null;
  }
}

class ExchangeFailed extends Error {}

/** Whether the process exits within `seconds`; the timer does not outlive the wait. */
async function exitsWithin(proc: Bun.Subprocess, seconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), seconds * 1000);
  });
  try {
    return await Promise.race([proc.exited.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The result of account/rateLimits/read from `codex app-server`, or null if that did not work
 * out. Read only: initialize, initialized, account/rateLimits/read, nothing that changes
 * state. The whole exchange is bounded by the timeout and the process is always terminated.
 */
export async function codexAppServer(host: Host): Promise<Record<string, unknown> | null> {
  const deadline = host.monotonic() + host.appServerTimeoutS;
  const line = commandLine("codex", ["app-server"], host);
  if (line === null) {
    return null;
  }
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = Bun.spawn(line.cmd, {
      ...line.options,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  const lines = new LineReader(proc.stdout);

  const send = async (message: Record<string, Json>) => {
    proc.stdin.write(`${dumps({ jsonrpc: "2.0", ...message })}\n`);
    await proc.stdin.flush();
  };

  const answer = async (want: number): Promise<unknown> => {
    for (;;) {
      const line = await lines.next(Math.max(0, deadline - host.monotonic()));
      if (line === "timeout" || line === null) {
        throw new ExchangeFailed();
      }
      let message: unknown;
      try {
        message = parseJson(line);
      } catch {
        continue; // notifications and noise
      }
      if (isRecord(message) && numericValue(message.id) === want && !Object.hasOwn(message, "method")) {
        if (Object.hasOwn(message, "error")) {
          throw new ExchangeFailed();
        }
        return message.result ?? null;
      }
    }
  };

  try {
    const clientInfo = { name: "agent-pace", version: VERSION };
    await send({ id: 1, method: "initialize", params: { clientInfo } });
    await answer(1);
    await send({ method: "initialized" });
    await send({ id: 2, method: "account/rateLimits/read", params: {} });
    const result = await answer(2);
    return isRecord(result) ? result : null;
  } catch (error) {
    if (error instanceof ExchangeFailed || isSystemError(error)) {
      return null;
    }
    throw error;
  } finally {
    try {
      await proc.stdin.end();
    } catch {
      // already gone
    }
    proc.kill("SIGTERM");
    if (!(await exitsWithin(proc, 3))) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    lines.close();
  }
}

/** Windows and banked resets from an account/rateLimits/read result; windows null if it has none. */
export function codexAppServerReading(
  result: Record<string, unknown>,
  observed: number,
  now: number,
): { windows: UsageWindow[] | null; banked: Banked | null } {
  const byId = get(result, "rateLimitsByLimitId");
  const snap = or(isRecord(byId) ? get(byId, "codex") : null, () => get(result, "rateLimits"));
  const windows: UsageWindow[] = [];
  for (const slot of ["secondary", "primary"]) {
    const w = isRecord(snap) ? get(snap, slot) : null;
    if (isRecord(w) && get(w, "usedPercent") !== null && truthy(get(w, "resetsAt"))) {
      const lengthS = toInt(or(get(w, "windowDurationMins"), () => 0)) * 60;
      windows.push(
        codexWindow(toFloat(get(w, "usedPercent")), lengthS, toFloat(get(w, "resetsAt")), observed, now),
      );
    }
  }
  const summary = get(result, "rateLimitResetCredits");
  let banked: Banked | null = null; // unknown
  const available = isRecord(summary) ? get(summary, "availableCount") : null;
  if (isRecord(summary) && isPythonInt(available)) {
    const listed = get(summary, "credits");
    let credits: Credit[] | null = null; // only the count is known
    if (Array.isArray(listed)) {
      credits = [];
      for (const c of listed) {
        if (!isRecord(c) || get(c, "status") !== "available" || get(c, "resetType") !== "codexRateLimits") {
          continue;
        }
        const expires = get(c, "expiresAt");
        credits.push({
          expiresAt: numericValue(expires),
          // decoded from JSON, so it is JSON
          title: get(c, "title") as Json,
          clears: null, // a Codex reset clears every window
        });
      }
      if (credits.some((c) => c.expiresAt !== null && !(c.expiresAt > 0 && c.expiresAt < 32503680000))) {
        // the format changed: read the session logs instead
        throw new RangeError("expiresAt is not unix seconds");
      }
    }
    banked = { count: Number(available), credits };
  }
  windows.sort((a, b) => a.lengthS - b.lengthS);
  return { windows: windows.length > 0 ? windows : null, banked };
}

/** Windows and banked resets from the app server; the session logs (resets unknown) if it fails. */
export async function codexReading(
  host: Host,
): Promise<{ windows: UsageWindow[]; banked: Banked | null; via: Via }> {
  const now = host.now();
  const result = await codexAppServer(host);
  if (result !== null) {
    let reading: ReturnType<typeof codexAppServerReading> | null = null;
    try {
      reading = codexAppServerReading(result, now, host.now());
    } catch (error) {
      // Python's AttributeError, TypeError and ValueError: a reply in a shape this does not know
      if (!(error instanceof TypeError || error instanceof RangeError)) {
        throw error;
      }
      reading = null;
    }
    if (reading?.windows) {
      return { windows: reading.windows, banked: reading.banked, via: "app-server" };
    }
  }
  return { windows: codexWindows(host), banked: null, via: "session-logs" };
}
