// The parity suite's fixture, ported from the Python version's tests/agent-pace.py. The
// responses are shaped like ones recorded from a real account, with the times and amounts
// changed. Time is fixed at 22 Oct 2025 11:25:57 UTC: the 7d window at 68%, resetting 28 Oct
// 07:14 UTC, and three "Full reset" credits expiring 23 Oct 23:10, 30 Oct 17:39 and 8 Nov
// 00:23 UTC. A fake `codex` on PATH plays the app server, a fake `claude` reports its version,
// and Claude's usage endpoint is replaced; nothing touches the network.

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import type { Host } from "../src/host.ts";
import { isoUtc } from "../src/time-format.ts";

export const NOW = 1761132357;
/** The 7d window's natural reset, 28 Oct 07:14 UTC. */
export const RESET = 1761635664;

export type Fields = Record<string, unknown>;

/** Banked Codex resets, as the app server lists them (ids dropped). */
export const CREDITS: readonly Fields[] = [
  {
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: 1758662422,
    expiresAt: 1761261048,
    title: "Full reset",
  },
  {
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: 1759260633,
    expiresAt: 1761845999,
    title: "Full reset",
  },
  {
    resetType: "codexRateLimits",
    status: "available",
    grantedAt: 1759967962,
    expiresAt: 1762561428,
    title: "Full reset",
  },
];

/** A Claude grant already used, so nothing is banked. */
export const RECORDED_GRANT: Fields = {
  id: "g1",
  label: "One usage-limit reset",
  type: "full",
  resets_total: 1,
  resets_left: 0,
  starts_at: "2025-10-21T00:00:00+00:00",
  ends_at: "2025-10-23T16:00:00+00:00",
  clears: ["five_hour", "seven_day", "seven_day_overage_included"],
  paused: false,
  usable_now: false,
};

const FAKE_CODEX = `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const mode = process.env.FAKE_CODEX_MODE;
writeFileSync(process.env.FAKE_CODEX_PID, String(process.pid));
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["app-server"])) process.exit(2);
if (mode === "fail") process.exit(1);
if (mode === "hang") await Bun.sleep(60000);
const print = (text) => process.stdout.write(text + "\\n");
for await (const line of console) {
  const msg = JSON.parse(line);
  appendFileSync(process.env.FAKE_CODEX_LOG, (msg.method ?? "response") + "\\n");
  if (msg.id === 1) {
    print(JSON.stringify({ id: 1, result: { userAgent: "fake", codexHome: "/x" } }));
  } else if (msg.method === "account/rateLimits/read") {
    print(JSON.stringify({ method: "account/updated", params: { planType: "pro" } }));
    if (mode === "error") {
      print(JSON.stringify({ id: 2, error: { code: -32000, message: "not signed in" } }));
    } else if (mode === "garbage") {
      print("not json");
      print(JSON.stringify({ id: 2, result: "nope" }));
    } else {
      print(readFileSync(process.env.FAKE_CODEX_RESPONSE, "utf8").trim());
    }
  }
}
`;

/** An account/rateLimits/read response as the app server answers it. */
export function response(
  options: {
    used?: number;
    credits?: readonly Fields[] | null;
    count?: number;
    summary?: boolean;
    reset?: number;
  } = {},
): { id: number; result: Fields } {
  const { used = 68, credits = CREDITS, count, summary = true, reset = RESET } = options;
  const snap: Fields = {
    limitId: "codex",
    primary: { usedPercent: used, windowDurationMins: 10080, resetsAt: reset },
    secondary: null,
  };
  const result: Fields = {
    ordinaryUsageAllowed: true,
    rateLimits: snap,
    rateLimitsByLimitId: { codex: snap },
    accountId: "x",
  };
  result.rateLimitResetCredits = summary
    ? { availableCount: count ?? (credits ?? []).length, credits }
    : null;
  return { id: 2, result };
}

/** Lane counts taken every step seconds after since and before until, as a watcher leaves them. */
export function every(step: number, since: number, until: number, count: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < Math.ceil((until - since) / step); i++) {
    out.push([since + i * step, count]);
  }
  return out;
}

/** A session-file line the way Claude Code writes it. */
export const compact = (event: unknown) => JSON.stringify(event);

export const iso = (t: number) => isoUtc(t).replace("+00:00", "Z");

/** Ends a --watch loop from the test's side. */
class StopWatching extends Error {}

export class Case {
  readonly dir = mkdtempSync(join(tmpdir(), "agent-pace-"));
  readonly paths = {
    response: join(this.dir, "response"),
    log: join(this.dir, "log"),
    pid: join(this.dir, "pid"),
  };
  readonly env: Record<string, string>;
  clock = NOW;
  appServerTimeoutS = 5;
  claude: Fields;
  claudeError: Error | null = null;
  /** Replaces the usage endpoint's answer, for its error statuses. */
  claudeResponse: (() => Response) | null = null;
  /** The exit status of the last run. */
  status = 0;
  /** Each sleep the watch loop asks for, in seconds; ends the loop after `sleeps` of them. */
  readonly slept: number[] = [];
  sleeps = Infinity;
  /** Runs before each sleep returns, to change the world between watch readings. */
  between: (() => void) | null = null;
  readonly requests: { url: string; headers: Headers }[] = [];

  constructor() {
    for (const sub of ["bin", "state", "codex-home/sessions/2025/10/22"]) {
      mkdirSync(join(this.dir, sub), { recursive: true });
    }
    this.writeCodex();
    this.env = {
      PATH: `${join(this.dir, "bin")}:/usr/bin:/bin`,
      HOME: this.dir,
      CODEX_HOME: join(this.dir, "codex-home"),
      CLAUDE_CONFIG_DIR: join(this.dir, "claude-home"),
      TZ: "Europe/London",
      CLAUDE_CODE_OAUTH_TOKEN: "test",
      FAKE_CODEX_MODE: "ok",
      FAKE_CODEX_RESPONSE: this.paths.response,
      FAKE_CODEX_LOG: this.paths.log,
      FAKE_CODEX_PID: this.paths.pid,
    };
    this.claude = {
      five_hour: { utilization: 6, resets_at: iso(NOW + 4200) },
      seven_day: { utilization: 40, resets_at: iso(NOW + 4 * 86400) },
      cedar_ember: {
        eligible: true,
        ineligible_reason: null,
        at_limit: false,
        exhausted: [],
        grants: [RECORDED_GRANT],
      },
    };
    this.writeClaude("2.1.999 (Claude Code)");
    this.serve(response());
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  get state(): string {
    return join(this.dir, "state");
  }

  host(): Host {
    return {
      env: this.env,
      platform: "linux",
      timeZone: "Europe/London",
      terminalColumns: undefined,
      appServerTimeoutS: this.appServerTimeoutS,
      now: () => this.clock,
      monotonic: () => performance.now() / 1000,
      fetch: async (url, init) => {
        this.requests.push({ url, headers: new Headers(init.headers) });
        if (this.claudeError) {
          throw this.claudeError;
        }
        return this.claudeResponse ? this.claudeResponse() : new Response(JSON.stringify(this.claude));
      },
      stdout: (text) => {
        this.out += text;
      },
      stderr: (text) => {
        this.err += text;
      },
      sleep: async (seconds) => {
        this.slept.push(seconds);
        if (this.slept.length >= this.sleeps) {
          throw new StopWatching();
        }
        this.between?.();
      },
    };
  }

  private out = "";
  private err = "";

  writeCodex(): void {
    const path = join(this.dir, "bin", "codex");
    writeFileSync(path, FAKE_CODEX);
    chmodSync(path, 0o755);
  }

  writeClaude(versionLine: string): void {
    const path = join(this.dir, "bin", "claude");
    writeFileSync(path, `#!/bin/sh\necho '${versionLine}'\n`);
    chmodSync(path, 0o755);
  }

  /** Bank a Claude grant (resets_left 1, a full reset ending at the given time unless overridden). */
  grant(fields: Fields): void {
    const block = this.claude.cedar_ember as Fields;
    block.grants = [{ ...RECORDED_GRANT, resets_left: 1, usable_now: true, ...fields }];
  }

  /** n Codex rollout files written age seconds before NOW. */
  codexLanes(n: number, age = 120): void {
    for (let i = 0; i < n; i++) {
      const path = join(this.dir, `codex-home/sessions/2025/10/22/rollout-lane${i}.jsonl`);
      writeFileSync(path, "{}\n");
      utimesSync(path, NOW - age, NOW - age);
    }
  }

  /**
   * n Claude Code session files (or subagent files) whose mtime is age and last assistant
   * message spoken seconds before `at` (NOW unless given).
   */
  claudeLanes(
    n: number,
    options: { age?: number; spoken?: number; subagents?: boolean; at?: number } = {},
  ): void {
    const { age = 120, subagents = false, at = NOW } = options;
    const spoken = options.spoken ?? age;
    for (let i = 0; i < n; i++) {
      const sub = subagents ? `claude-home/projects/proj/sess${i}/subagents` : "claude-home/projects/proj";
      mkdirSync(join(this.dir, sub), { recursive: true });
      const path = join(this.dir, sub, `lane${i}.jsonl`);
      writeFileSync(
        path,
        `${compact({ type: "user", timestamp: iso(at - spoken - 5) })}\n` +
          `${compact({ type: "assistant", timestamp: iso(at - spoken), message: { content: [{ type: "text" }] } })}\n` +
          `${compact({ type: "last-prompt" })}\n`,
      );
      utimesSync(path, at - age, at - age);
    }
  }

  /** Earlier lane counts (time, active lanes) as the lane history file holds them. */
  laneHistory(source: string, points: readonly (readonly [number, number])[]): void {
    writeFileSync(
      join(this.state, `lanes-${source}.csv`),
      points.map(([t, count]) => `${t},${count},0\n`).join(""),
    );
  }

  /** Earlier readings (time, used) of a window, as the history file holds them. */
  history(source: string, name: string, points: readonly (readonly [number, number])[], reset = RESET): void {
    writeFileSync(
      join(this.state, `${source}-${name}.csv`),
      points.map(([t, used]) => `${t},${used},${reset}\n`).join(""),
    );
  }

  serve(resp: unknown, mode = "ok"): void {
    writeFileSync(this.paths.response, JSON.stringify(resp));
    this.env.FAKE_CODEX_MODE = mode;
  }

  sessionLog(used = 68, timestamp = "2025-10-22T11:25:30.000Z"): string {
    const line = {
      timestamp,
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: used, window_minutes: 10080, resets_at: RESET },
          secondary: null,
        },
      },
    };
    const path = join(this.dir, "codex-home/sessions/2025/10/22/rollout-test.jsonl");
    writeFileSync(path, `${JSON.stringify(line)}\n`);
    return path;
  }

  /** A scratch copy of the state directory, so one test can read the same history twice. */
  copyState(): string {
    const dest = join(mkdtempSync(join(this.dir, "copy-")), "state");
    cpSync(this.state, dest, { recursive: true });
    return dest;
  }

  scratchState(): string {
    return mkdtempSync(join(this.dir, "state-"));
  }

  async runPace(...argv: string[]): Promise<[string, string]> {
    return this.runAs("agent-pace", ...argv);
  }

  /** The command run under another name, such as claude-pace. */
  async runAs(prog: string, ...argv: string[]): Promise<[string, string]> {
    this.out = "";
    this.err = "";
    const args = argv.includes("--state") ? argv : [...argv, "--state", this.state];
    try {
      this.status = await main(args, prog, this.host());
    } catch (error) {
      if (!(error instanceof StopWatching)) {
        throw error;
      }
    }
    return [this.out, this.err];
  }

  /** The recommendation without its lane counts (the lane tests read those). */
  async plan(...extra: string[]): Promise<string> {
    return (await this.planLine(...extra)).split(" (lanes: ")[0] ?? "";
  }

  async planLine(...extra: string[]): Promise<string> {
    const [out, err] = await this.runPace("plan", ...extra);
    return out ? (out.split("\n")[0] ?? "") : err;
  }

  async claudeOut(...extra: string[]): Promise<string> {
    return (await this.runPace("claude", ...extra))[0];
  }

  async codex(...extra: string[]): Promise<string> {
    return (await this.runPace("codex", ...extra))[0];
  }

  async json(source: string, ...extra: string[]): Promise<Fields> {
    return JSON.parse((await this.runPace(source, "--json", ...extra))[0]);
  }

  methods(): string[] {
    return readFileSync(this.paths.log, "utf8").split(/\s+/).filter(Boolean);
  }

  remove(relative: string): void {
    rmSync(join(this.dir, relative));
  }

  /** A file that vanishes between listing and stat: a link to nothing. */
  dangle(relative: string): void {
    rmSync(join(this.dir, relative));
    symlinkSync(join(this.dir, "nowhere"), join(this.dir, relative));
  }
}
