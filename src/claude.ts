import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { ExitError, NetworkError, RateLimited } from "./errors.ts";
import { claudeHome, commandLine, type Host } from "./host.ts";
import { get, isPythonInt, isRecord, items, type Json, parseJson, toFloat, truthy } from "./python-json.ts";
import { parseIso } from "./time-format.ts";
import type { Banked, Credit, Reading, UsageWindow } from "./usage.ts";

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
/** The Claude Code version to claim when `claude --version` cannot be read. */
export const CLAUDE_CLI_FALLBACK = "2.1.304";

const decoder = new TextDecoder();

function run(command: string, args: string[], host: Host): string | null {
  const line = commandLine(command, args, host);
  if (line === null) {
    return null;
  }
  const result = Bun.spawnSync(line.cmd, {
    ...line.options,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  return result.exitedDueToTimeout ? null : decoder.decode(result.stdout);
}

export function claudeToken(host: Host): string {
  const fromEnv = host.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (fromEnv) {
    return fromEnv;
  }
  let raw: string | null = null;
  if (host.platform === "darwin") {
    try {
      const args = ["find-generic-password", "-s", "Claude Code-credentials", "-w"];
      raw = run("security", args, host)?.trim() || null;
    } catch {
      raw = null;
    }
  }
  if (raw === null) {
    try {
      raw = readFileSync(join(claudeHome(host.env), ".credentials.json"), "utf8");
    } catch {
      throw new ExitError(
        "agent-pace: no Claude Code login found (log in with `claude`, or set CLAUDE_CODE_OAUTH_TOKEN)",
      );
    }
  }
  try {
    const token = get(get(JSON.parse(raw), "claudeAiOauth"), "accessToken");
    if (typeof token === "string") {
      return token;
    }
  } catch {
    // reported below
  }
  throw new ExitError("agent-pace: could not read the Claude Code credentials");
}

/** The installed Claude Code version, remembered for a day so `claude --version` does not run on every reading. */
export function claudeCliVersion(state: string, host: Host): string {
  const path = join(state, "claude-cli-version");
  try {
    if (Math.abs(host.now() - statSync(path).mtimeMs / 1000) < 86400) {
      const cached = readFileSync(path, "utf8").trim();
      if (cached) {
        return cached;
      }
    }
  } catch {
    // not remembered
  }
  let found: string | null = null;
  try {
    found = /\d+\.\d+\.\d+/.exec(run("claude", ["--version"], host) ?? "")?.[0] ?? null;
  } catch {
    found = null;
  }
  if (found !== null) {
    try {
      mkdirSync(state, { recursive: true });
      writeFileSync(path, found);
    } catch {
      // remembered next time, perhaps
    }
  }
  return found ?? CLAUDE_CLI_FALLBACK;
}

/** The Claude windows agent-pace paces: the usage response's key, the name, the length. */
export const CLAUDE_WINDOWS = [
  { key: "five_hour", name: "5h", lengthS: 5 * 3600 },
  { key: "seven_day", name: "7d", lengthS: 7 * 86400 },
] as const;

/**
 * Banked Claude resets (what /limit-reset claims) from the usage response's cedar_ember
 * block. A grant with resets left that is not paused is banked; ends_at is when it expires.
 * banked is null when it cannot be known.
 */
export function claudeBanked(data: unknown): { banked: Banked | null; note: string | null } {
  const block = get(data, "cedar_ember");
  if (!isRecord(block)) {
    return { banked: null, note: null }; // not reported for this login
  }
  const reason = get(block, "ineligible_reason");
  if (get(block, "eligible") === false) {
    if (reason === "surface" || reason === "cli_version") {
      // the server did not take us for Claude Code
      return {
        banked: null,
        note: `Claude banked resets unknown (the usage endpoint says ${reason})`,
      };
    }
    if (reason === "tier" || reason === "tenure" || reason === "mobile") {
      return { banked: { count: 0, credits: [] }, note: null };
    }
  }
  const credits: Credit[] = [];
  const grants = get(block, "grants");
  for (const g of truthy(grants) ? items(grants) : []) {
    const left = isRecord(g) ? get(g, "resets_left") : null;
    if (!isRecord(g) || truthy(get(g, "paused")) || !isPythonInt(left)) {
      continue;
    }
    let clears: string[];
    if (truthy(get(g, "clears"))) {
      const names = new Set<string>();
      for (const key of items(get(g, "clears"))) {
        const name = CLAUDE_WINDOWS.find((w) => w.key === key)?.name;
        if (name !== undefined) {
          names.add(name);
        }
      }
      clears = [...names].sort();
      if (clears.length === 0) {
        continue; // it clears nothing agent-pace paces
      }
    } else {
      // fall back to the grant type: a session reset only clears the 5h window
      clears = get(g, "type") === "session" ? ["5h"] : ["5h", "7d"];
    }
    let ends: number | null = null;
    const endsAt = get(g, "ends_at");
    if (truthy(endsAt)) {
      try {
        if (typeof endsAt === "string") {
          ends = parseIso(endsAt.replaceAll("Z", "+00:00"));
        }
      } catch {
        ends = null;
      }
    }
    // decoded from JSON, so it is JSON
    const title = get(g, "label") as Json;
    for (let i = 0; i < Math.max(0, Number(left)); i++) {
      credits.push({ expiresAt: ends, title, clears });
    }
  }
  return { banked: { count: credits.length, credits }, note: null };
}

/** Why fetch failed, as urllib's URLError reason said it where the failure is the same. */
function fetchFailure(error: unknown, host: Host): string {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (code === "ConnectionRefused") {
    return `[Errno ${constants.errno.ECONNREFUSED}] Connection refused`;
  }
  if (code === "ENOTFOUND") {
    return host.platform === "darwin"
      ? "[Errno 8] nodename nor servname provided, or not known"
      : "[Errno -2] Name or service not known";
  }
  return error instanceof Error ? error.message : String(error);
}

async function usageResponse(state: string, host: Host): Promise<unknown> {
  // One call gives the windows and the banked resets. The server only evaluates reset
  // eligibility for the Claude Code surface, so this identifies as the installed Claude Code
  // (undocumented, may change).
  const headers = {
    Authorization: `Bearer ${claudeToken(host)}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": `claude-cli/${claudeCliVersion(state, host)} (external, cli)`,
    "x-app": "cli",
  };
  const signal = AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await host.fetch(USAGE_URL, { headers, signal });
  } catch (error) {
    // a server that accepts the connection and does not answer: Python's socket timeout
    throw new NetworkError(signal.aborted ? "timed out" : `<urlopen error ${fetchFailure(error, host)}>`);
  }
  if (response.status === 401) {
    throw new ExitError("agent-pace: Claude token rejected (expired?); run `claude` once to refresh it");
  }
  if (response.status === 429) {
    throw new RateLimited(response.headers.get("retry-after"));
  }
  if (response.status >= 400) {
    throw new NetworkError(`HTTP Error ${response.status}: ${response.statusText}`);
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw new NetworkError(
      signal.aborted
        ? "The read operation timed out"
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
  return parseJson(body);
}

export async function claudeReading(state: string, host: Host): Promise<Reading> {
  const data = await usageResponse(state, host);
  const now = host.now();
  const windows: UsageWindow[] = [];
  for (const { key, name, lengthS } of CLAUDE_WINDOWS) {
    const w = get(data, key);
    if (truthy(w) && truthy(get(w, "resets_at"))) {
      const resetsAt = get(w, "resets_at");
      if (typeof resetsAt !== "string") {
        throw new TypeError("resets_at is not a string");
      }
      if (!isRecord(w) || !Object.hasOwn(w, "utilization")) {
        throw new TypeError("utilization is missing");
      }
      windows.push({
        name,
        used: toFloat(get(w, "utilization")),
        lengthS,
        observedAt: now,
        resetsAt: parseIso(resetsAt.replaceAll("Z", "+00:00")),
      });
    }
  }
  if (windows.length === 0) {
    throw new ExitError("agent-pace: no usage windows for this Claude login (subscription logins only)");
  }
  const { banked, note } = claudeBanked(data);
  return { windows, banked, note, via: "usage-api" };
}
