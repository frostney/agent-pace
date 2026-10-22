// Each lane's burn measured from its own tokens: the ledger read from the session files, the
// points per dollar learned from the window history, and the lane headroom that follows.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fitTokenCost, laneRates } from "../src/token-burn.ts";
import { type TokenUse, tokenReading } from "../src/token-ledger.ts";
import { Case, compact, type Fields, iso, NOW } from "./harness.ts";

setDefaultTimeout(30_000);

let c: Case;

beforeEach(() => {
  c = new Case();
});

afterEach(() => {
  c.cleanup();
});

/** The ledger after a reading; a reading always has one in these tests. */
async function ledger(): Promise<TokenUse> {
  const use = await tokenReading(c.state, "claude", c.host());
  if (use === null) {
    throw new Error("no ledger");
  }
  return use;
}

/** The start of the minute NOW falls in: messages here sit at the start of their minute. */
const M = Math.floor(NOW / 60) * 60;
const R5 = Math.trunc(NOW + 4200);

/** Opus 5.5 output tokens worth `dollars` at its $20 per million. */
const opusOutput = (dollars: number): Fields => ({
  input_tokens: 0,
  output_tokens: (dollars / 20) * 1e6,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/** A lane with one message a minute for the last `minutes`, each worth `dollars`. */
const lane = (name: string, minutes: number, dollars: number) =>
  c.claudeSpending(
    name,
    Array.from({ length: minutes }, (_, i) => ({
      t: M - 60 * (minutes - i),
      id: `${name}-${i}`,
      model: "claude-opus-5-5",
      usage: opusOutput(dollars),
    })),
  );

describe("TokenLedger", () => {
  test("a message is counted once however many lines carry it", async () => {
    lane("a", 3, 1);
    const use = await tokenReading(c.state, "claude", c.host());
    expect(use?.spent(NOW - 3600, NOW)).toBeCloseTo(3, 9);
  });

  test("each kind of token is priced as the model's list price says", async () => {
    c.claudeSpending("a", [
      {
        t: M - 60,
        id: "m1",
        model: "claude-sonnet-5-5",
        usage: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_input_tokens: 1_000_000,
          cache_creation_input_tokens: 3_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 2_000_000 },
        },
      },
      {
        t: M - 120,
        id: "m2",
        model: "claude-opus-5-5",
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      },
    ]);
    const use = await tokenReading(c.state, "claude", c.host());
    // Sonnet 5.5: $2 input + $10 output + $0.20 cache read + 1M at 1.25 x $2 + 2M at 2 x $2; Opus 5.5: $4 input
    expect(use?.spent(NOW - 3600, NOW)).toBeCloseTo(2 + 10 + 0.2 + 2.5 + 8 + 4, 9);
  });

  test("a later reading counts only what was appended", async () => {
    const path = lane("a", 2, 1);
    await tokenReading(c.state, "claude", c.host());
    appendFileSync(
      path,
      `${compact({ type: "assistant", timestamp: iso(M + 10), message: { id: "late", model: "claude-opus-5-5", usage: opusOutput(5) } })}\n`,
    );
    utimesSync(path, NOW, NOW);
    c.clock = NOW + 120;
    const use = await tokenReading(c.state, "claude", c.host());
    expect(use?.spent(NOW - 3600, NOW + 120)).toBeCloseTo(7, 9);
    const ledger = JSON.parse(readFileSync(join(c.state, "tokens-claude.json"), "utf8"));
    expect(ledger.offsets["proj/a.jsonl"]).toBe(readFileSync(path).length);
  });

  test("a message copied into a forked session is counted once, in the lane that wrote it", async () => {
    const original = lane("a", 3, 1);
    await ledger();
    // the fork copies the conversation so far, then goes on with a message of its own
    const fork = join(c.dir, "claude-home/projects/proj/fork.jsonl");
    writeFileSync(
      fork,
      readFileSync(original, "utf8") +
        `${compact({ type: "assistant", timestamp: iso(M - 30), message: { id: "own", model: "claude-opus-5-5", usage: opusOutput(2) } })}\n`,
    );
    utimesSync(fork, NOW - 30, NOW - 30);
    const use = await ledger();
    expect(use.spent(NOW - 3600, NOW)).toBeCloseTo(5, 9);
    expect(use.byLane(NOW - 3600, NOW).get("proj/a.jsonl")?.dollars).toBeCloseTo(3, 9);
  });

  test("a message's last line, which carries its final output count, is the one counted", async () => {
    const path = join(c.dir, "claude-home/projects/proj/a.jsonl");
    mkdirSync(join(c.dir, "claude-home/projects/proj"), { recursive: true });
    const line = (dollars: number) =>
      `${compact({ type: "assistant", timestamp: iso(M - 60), message: { id: "m", model: "claude-opus-5-5", usage: opusOutput(dollars) } })}\n`;
    writeFileSync(path, line(0.5) + line(2));
    utimesSync(path, NOW - 60, NOW - 60);
    expect((await ledger()).spent(NOW - 3600, NOW)).toBeCloseTo(2, 9);
  });

  test("a character a read cuts in two moves no offset", async () => {
    const path = join(c.dir, "claude-home/projects/proj/a.jsonl");
    mkdirSync(join(c.dir, "claude-home/projects/proj"), { recursive: true });
    // a user line long enough that the 4 MiB read ends inside its "é"
    const filler = `${compact({ type: "user", content: "x" })}`;
    const pad = 4 * 1024 * 1024 - Buffer.byteLength(filler) + 2;
    const first = `${compact({ type: "user", content: `${"x".repeat(pad)}é` })}\n`;
    const spend = (id: string, dollars: number) =>
      `${compact({ type: "assistant", timestamp: iso(M - 60), message: { id, model: "claude-opus-5-5", usage: opusOutput(dollars) } })}\n`;
    writeFileSync(path, first + spend("m1", 1));
    utimesSync(path, NOW - 60, NOW - 60);
    await ledger();
    appendFileSync(path, spend("m2", 2));
    const use = await ledger();
    const kept = JSON.parse(readFileSync(join(c.state, "tokens-claude.json"), "utf8"));
    expect(kept.offsets["proj/a.jsonl"]).toBe(readFileSync(path).length);
    expect(use.spent(NOW - 3600, NOW)).toBeCloseTo(3, 9);
  });

  test("a file rewritten from the start is read again without counting twice", async () => {
    const path = lane("a", 3, 1);
    await ledger();
    const text = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, `${text.slice(0, 2).join("\n")}\n`); // shorter than what was read: rewritten
    utimesSync(path, NOW - 60, NOW - 60);
    expect((await ledger()).spent(NOW - 3600, NOW)).toBeCloseTo(3, 9);
  });

  test("a session file reached through a link is read", async () => {
    const real = lane("a", 2, 1);
    const other = join(c.dir, "elsewhere");
    mkdirSync(other);
    renameSync(real, join(other, "a.jsonl"));
    symlinkSync(join(other, "a.jsonl"), real);
    expect((await ledger()).spent(NOW - 3600, NOW)).toBeCloseTo(2, 9);
  });

  test("a lane that aged out is dropped and the others keep their costs", async () => {
    const old = lane("a", 2, 1);
    await ledger();
    rmSync(old);
    c.clock = NOW + 9 * 86400; // a's costs are older than the ledger keeps
    c.claudeSpending(
      "b",
      [{ t: c.clock - 60, id: "b1", model: "claude-opus-5-5", usage: opusOutput(2) }],
      c.clock - 30,
    );
    const use = await ledger();
    expect([...use.byLane(c.clock - 3600, c.clock)]).toEqual([
      ["proj/b.jsonl", { dollars: 2, first: Math.floor((c.clock - 60) / 60) * 60 }],
    ]);
    const kept = JSON.parse(readFileSync(join(c.state, "tokens-claude.json"), "utf8"));
    expect(kept.lanes).toEqual(["proj/b.jsonl"]);
  });

  test("codex responses are priced from their usage records", async () => {
    const dir = join(c.dir, "codex-home/sessions/2025/10/22");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "rollout-x.jsonl");
    const record = (t: number, id: string, usage: Fields) =>
      `${JSON.stringify({ timestamp: iso(t), type: "token_usage_record", payload: { response_id: id, usage } })}\n`;
    writeFileSync(
      path,
      `${JSON.stringify({ timestamp: iso(M - 300), type: "turn_context", payload: { model: "gpt-x" } })}\n` +
        record(M - 120, "r1", {
          input_tokens: 1_000_000,
          cached_input_tokens: 800_000,
          output_tokens: 100_000,
        }) +
        record(M - 120, "r1", {
          input_tokens: 1_000_000,
          cached_input_tokens: 800_000,
          output_tokens: 100_000,
        }),
    );
    utimesSync(path, NOW - 60, NOW - 60);
    const use = await tokenReading(c.state, "codex", c.host());
    // 200k uncached at $1.25, 800k cached at $0.125, 100k output at $10, once
    expect(use?.spent(NOW - 3600, NOW)).toBeCloseTo(0.25 + 0.1 + 1, 9);
  });
});

describe("TokenCost", () => {
  test("points per dollar are the points moved over the dollars spent, run by run", async () => {
    lane("a", 60, 1);
    lane("b", 60, 0.5);
    const use = await ledger();
    const rows = [
      [NOW - 3660, 10, R5],
      [NOW - 1800, 20, R5],
      [NOW, 30, R5],
    ] as const;
    expect(fitTokenCost(rows, use)).toEqual({
      pointsPerDollar: 20 / 90,
      runs: 1,
      points: 20,
      dollars: 90,
    });
  });

  test("a run with no local spending and a run below the evidence bar teach nothing", async () => {
    lane("a", 10, 1);
    const use = await ledger();
    const quiet = [
      [NOW - 30000, 5, R5 - 18000],
      [NOW - 25000, 15, R5 - 18000],
    ] as const; // a window another machine moved: no local spending then
    const small = [
      [NOW - 660, 20, R5],
      [NOW, 22, R5],
    ] as const; // two points: off by up to a half
    expect(fitTokenCost([...quiet, ...small], use)).toBeNull();
    expect(fitTokenCost([...quiet, [NOW - 660, 20, R5], [NOW, 23, R5]], use)).toEqual({
      pointsPerDollar: 3 / 10,
      runs: 1,
      points: 3,
      dollars: 10,
    });
  });

  test("the evidence bar asks for three points a run", async () => {
    lane("a", 120, 1);
    const use = await ledger();
    // two runs of 2 and 3 points: 5 points, under the 6 two runs need
    const two = [
      [NOW - 7140, 10, R5 - 18000],
      [NOW - 3660, 12, R5 - 18000],
      [NOW - 3600, 0, R5],
      [NOW, 3, R5],
    ] as const;
    expect(fitTokenCost(two, use)).toBeNull();
    const enough = [two[0], two[1], two[2], [NOW, 4, R5]] as const;
    expect(fitTokenCost(enough, use)?.points).toBe(6);
  });

  test("a run in which the local lanes barely spent is left out", async () => {
    lane("a", 60, 1);
    c.claudeSpending("b", [{ t: M - 30000, id: "tiny", model: "claude-opus-5-5", usage: opusOutput(0.5) }]);
    const use = await ledger();
    const rows = [
      [NOW - 30060, 10, R5 - 36000],
      [NOW - 25000, 40, R5 - 36000], // another machine moved this window 30 points; a lane here spent $0.50
      [NOW - 3660, 10, R5],
      [NOW, 30, R5],
    ] as const;
    expect(fitTokenCost(rows, use)).toEqual({ pointsPerDollar: 20 / 60, runs: 1, points: 20, dollars: 60 });
  });

  test("the week that just ended still teaches the 7d window", async () => {
    c.claudeSpending(
      "a",
      Array.from({ length: 60 }, (_, i) => ({
        t: M - 7.5 * 86400 + 60 * i,
        id: `w${i}`,
        model: "claude-opus-5-5",
        usage: opusOutput(1),
      })),
    );
    const use = await ledger();
    const lastWeek = [
      [NOW - 7.5 * 86400 - 60, 2, NOW - 3600],
      [NOW - 7.5 * 86400 + 3600, 8, NOW - 3600],
    ] as const; // began seven and a half days ago, within the eight the ledger keeps
    expect(fitTokenCost(lastWeek, use)?.pointsPerDollar).toBeCloseTo(6 / 60, 9);
  });

  test("each lane burns at its own rate", async () => {
    lane("a", 60, 1);
    lane("b", 60, 0.5);
    const use = await ledger();
    const fit = { pointsPerDollar: 0.2, runs: 1, points: 20, dollars: 100 };
    const span = NOW - (M - 29 * 60); // the 29 minutes inside the last half hour, from the first
    expect(laneRates(use, fit, NOW)).toEqual([
      (29 * 1 * 0.2) / (span / 3600),
      (29 * 0.5 * 0.2) / (span / 3600),
    ]);
  });
});

describe("TokenLanes", () => {
  /** Claude's 5h window at 30%, up 20 points over the last hour while lanes a and b spent $60 and $30. */
  const measured = () => {
    (c.claude.five_hour as Fields).utilization = 30;
    c.history(
      "claude",
      "5h",
      [
        [NOW - 3660, 10],
        [NOW - 1800, 20],
      ],
      R5,
    );
    lane("a", 60, 1);
    lane("b", 60, 0.5);
  };

  test("the headroom counts each lane at its own burn", async () => {
    measured();
    const data = await c.json("claude");
    const five = (data.windows as Fields[])[0] as Fields;
    const ppd = 20 / 90;
    const span = NOW - (M - 29 * 60);
    const rates = [29 * 1, 29 * 0.5].map((dollars) => (dollars * ppd) / (span / 3600));
    const total = (rates[0] ?? 0) + (rates[1] ?? 0);
    const mean = total / 2;
    const hours = five.hours_left as number;
    expect(five.lane_basis).toBe("tokens");
    expect(five.lane_rates).toEqual(rates.map((r) => Math.round(r * 100) / 100));
    expect(five.per_lane_rate).toBe(Math.round(mean * 100) / 100);
    expect(five.lane_headroom).toBe(Math.floor(((97 - 30) / ((R5 - NOW) / 3600) - total) / mean));
    expect(five.token_cost).toEqual({ points_per_dollar: ppd, runs: 1, points: 20, dollars: 90 });
    expect(hours).toBe(1.17);
  });

  test("a cost learned in an earlier window measures lanes the new window cannot yet", async () => {
    // the last 5h window moved 20 points while lane a spent $60; this one has moved 2 points in ten minutes
    c.claudeSpending("a", [
      ...Array.from({ length: 60 }, (_, i) => ({
        t: M - 21600 + 60 * i,
        id: `old-${i}`,
        model: "claude-opus-5-5",
        usage: opusOutput(1),
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        t: M - 600 + 60 * i,
        id: `new-${i}`,
        model: "claude-opus-5-5",
        usage: opusOutput(1),
      })),
    ]);
    c.history(
      "claude",
      "5h",
      [
        [NOW - 21660, 10],
        [NOW - 18000, 30],
      ],
      R5 - 18000,
    );
    c.history(
      "claude",
      "5h",
      [
        [NOW - 21660, 10],
        [NOW - 18000, 30],
      ],
      R5 - 18000,
    );
    appendFileSync(join(c.state, "claude-5h.csv"), `${NOW - 600},0,${R5}\n`);
    (c.claude.five_hour as Fields).utilization = 2;
    const five = ((await c.json("claude")).windows as Fields[])[0] as Fields;
    // both runs teach the fit: 20 points over $60 then, 2 points over the $9 of this window's run
    const ppd = 22 / 69;
    const rate = (10 * ppd) / ((NOW - (M - 600)) / 3600);
    expect([five.rate_per_hour, five.lane_basis, five.lane_rates]).toEqual([
      null,
      "tokens",
      [Math.round(rate * 100) / 100],
    ]);
    expect(five.lane_headroom).toBe(Math.floor(((97 - 2) / ((R5 - NOW) / 3600) - rate) / rate));
  });

  test("a lane that spent nothing lately is not counted as burning", async () => {
    lane("a", 60, 1);
    c.claudeSpending("idle", [{ t: M - 120, id: "idle-0", model: "claude-opus-5-5", usage: opusOutput(0) }]);
    const use = await ledger();
    expect(laneRates(use, { pointsPerDollar: 0.2, runs: 1, points: 20, dollars: 100 }, NOW)).toHaveLength(1);
  });

  test("without a learned cost the lanes are shared out as before", async () => {
    (c.claude.five_hour as Fields).utilization = 30;
    lane("a", 60, 1);
    const five = ((await c.json("claude")).windows as Fields[])[0] as Fields;
    expect([five.lane_basis, five.lane_rates, five.token_cost]).toEqual([null, null, null]);
  });
});
