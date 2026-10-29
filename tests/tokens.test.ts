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
import { codexPrice, codexTierFactor } from "../src/token-prices.ts";
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

  test("a Haiku 5.5 prompt over 100K tokens pays five times every rate", async () => {
    // a prompt of input, cache reads and cache writes: 10k + 60k + 30k is exactly 100K
    const haiku = (input: number) => ({
      input_tokens: input,
      output_tokens: 1_000,
      cache_read_input_tokens: 60_000,
      cache_creation_input_tokens: 30_000,
      cache_creation: { ephemeral_5m_input_tokens: 30_000, ephemeral_1h_input_tokens: 0 },
    });
    c.claudeSpending("under", [{ t: M - 60, id: "h1", model: "claude-haiku-5-5", usage: haiku(10_000) }]);
    c.claudeSpending("over", [{ t: M - 60, id: "h2", model: "claude-haiku-5-5", usage: haiku(10_010) }]);
    const use = await tokenReading(c.state, "claude", c.host());
    const lanes = use?.byLane(NOW - 3600, NOW);
    // $0.10 input, $0.01 cache read, $0.125 5-minute write, $0.50 output
    const under = (10_000 * 0.1 + 60_000 * 0.01 + 30_000 * 0.125 + 1_000 * 0.5) / 1e6;
    const over = (5 * (10_010 * 0.1 + 60_000 * 0.01 + 30_000 * 0.125 + 1_000 * 0.5)) / 1e6;
    expect(lanes?.get("proj/under.jsonl")?.dollars).toBeCloseTo(under, 9);
    expect(lanes?.get("proj/over.jsonl")?.dollars).toBeCloseTo(over, 9);
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

  test("on a first reading a fork's copies go to the session that wrote them", async () => {
    const original = lane("a", 3, 1);
    const fork = join(c.dir, "claude-home/projects/proj/0-fork.jsonl"); // listed before the original
    writeFileSync(fork, readFileSync(original, "utf8"));
    utimesSync(fork, NOW - 30, NOW - 30);
    utimesSync(original, NOW - 90, NOW - 90);
    const use = await ledger();
    expect(use.byLane(NOW - 3600, NOW).get("proj/a.jsonl")?.dollars).toBeCloseTo(3, 9);
    expect(use.byLane(NOW - 3600, NOW).has("proj/0-fork.jsonl")).toBe(false);
  });

  test("a deleted session's recent costs stay for the fit", async () => {
    const gone = lane("a", 3, 1);
    lane("b", 1, 1);
    await ledger();
    rmSync(gone);
    expect((await ledger()).spent(NOW - 3600, NOW)).toBeCloseTo(4, 9);
  });

  test("a linked directory is not entered", async () => {
    lane("a", 2, 1);
    symlinkSync("..", join(c.dir, "claude-home/projects/proj/up"));
    const use = await ledger();
    expect([...use.byLane(NOW - 3600, NOW).keys()]).toEqual(["proj/a.jsonl"]);
  });

  test("a request older than the ledger keeps is not counted", async () => {
    c.claudeSpending("a", [
      { t: M - 9 * 86400, id: "old", model: "claude-opus-5-5", usage: opusOutput(5) },
      { t: M - 60, id: "new", model: "claude-opus-5-5", usage: opusOutput(1) },
    ]);
    expect((await ledger()).spent(0, NOW)).toBeCloseTo(1, 9);
  });

  test("fast mode costs twice as much", async () => {
    c.claudeSpending("a", [
      { t: M - 60, id: "f", model: "claude-opus-5-5", usage: { ...opusOutput(1), speed: "fast" } },
    ]);
    expect((await ledger()).spent(NOW - 3600, NOW)).toBeCloseTo(2, 9);
  });

  test("a file rewritten with new content counts the new requests", async () => {
    const path = lane("a", 3, 1);
    await ledger();
    writeFileSync(
      path,
      `${compact({ type: "assistant", timestamp: iso(M - 60), message: { id: "fresh", model: "claude-opus-5-5", usage: opusOutput(4) } })}\n`,
    );
    utimesSync(path, NOW - 60, NOW - 60);
    expect((await ledger()).spent(NOW - 3600, NOW)).toBeCloseTo(7, 9);
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

  test("after a lane ages out, a later line of another lane's request still goes to that lane", async () => {
    const later = NOW + 9 * 86400;
    const old = lane("a", 1, 1);
    const at = (name: string, id: string, dollars: number) =>
      c.claudeSpending(
        name,
        [{ t: later - 120, id, model: "claude-opus-5-5", usage: opusOutput(dollars) }],
        later - 60,
      );
    const b = at("b", "b1", 1);
    at("c", "c1", 1);
    await ledger(); // lanes a, b, c
    rmSync(old);
    c.clock = later;
    await ledger(); // a ages out: b and c are renumbered
    appendFileSync(
      b,
      `${compact({ type: "assistant", timestamp: iso(later - 120), message: { id: "b1", model: "claude-opus-5-5", usage: opusOutput(3) } })}\n`,
    );
    utimesSync(b, later - 30, later - 30);
    const use = await ledger();
    const lanes = [...use.byLane(later - 3600, later)].map(([name, { dollars }]) => [name, dollars]);
    expect(lanes.sort()).toEqual([
      ["proj/b.jsonl", 3],
      ["proj/c.jsonl", 1],
    ]);
  });

  test("codex responses are priced by their own model and service tier", async () => {
    const dir = join(c.dir, "codex-home/sessions/2025/10/22");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "rollout-x.jsonl");
    const line = (t: number, type: string, payload: Fields) =>
      `${JSON.stringify({ timestamp: iso(t), type, payload })}\n`;
    const record = (t: number, id: string, usage: Fields) =>
      line(t, "token_usage_record", { response_id: id, usage });
    const usage = {
      input_tokens: 200_000,
      cached_input_tokens: 100_000,
      cache_write_input_tokens: 50_000,
      output_tokens: 10_000,
    };
    const fast = (model: string) =>
      line(M - 200, "event_msg", {
        type: "thread_settings_applied",
        thread_settings: { model, service_tier: "priority" },
      });
    writeFileSync(
      path,
      line(M - 300, "turn_context", { model: "gpt-6-sol" }) +
        record(M - 240, "r1", usage) +
        record(M - 240, "r1", usage) +
        // a message that only mentions the settings changes nothing
        line(M - 230, "response_item", { type: "message", text: '"turn_context" model', model: "gpt-x" }) +
        record(M - 220, "r2", { input_tokens: 300_000, output_tokens: 10_000 }) +
        fast("gpt-6.1-sol") +
        record(M - 180, "r3", usage),
    );
    utimesSync(path, NOW - 60, NOW - 60);
    const first = await tokenReading(c.state, "codex", c.host());
    // gpt-6-sol: 50k uncached at $2, 100k cached at $0.20, 50k written at $2.50, 10k output at $10
    const sol = 0.1 + 0.02 + 0.125 + 0.1;
    // a 300k prompt is long context: input at $4, output at $15
    const long = 1.2 + 0.15;
    // gpt-6.1-sol caches at $0.10, at twice the price in the priority tier
    const fastSol = 2 * (0.1 + 0.01 + 0.125 + 0.1);
    expect(first?.spent(NOW - 3600, NOW)).toBeCloseTo(sol + long + fastSol, 9);
    // the next reading starts where this one stopped, still on gpt-6.1-sol in the priority tier
    appendFileSync(path, record(M - 60, "r4", usage));
    utimesSync(path, NOW - 30, NOW - 30);
    const second = await tokenReading(c.state, "codex", c.host());
    expect(second?.spent(NOW - 3600, NOW)).toBeCloseTo(sol + long + 2 * fastSol, 9);
  });
});

describe("codexPrice", () => {
  test("a dated snapshot is priced as its model", () => {
    expect(codexPrice("gpt-6-sol-2026-08-01", 1000)).toEqual(codexPrice("gpt-6-sol", 1000));
  });

  test("an unlisted model is priced as the current model of its tier", () => {
    expect(codexPrice("gpt-7-astra", 1000)).toEqual(codexPrice("gpt-6-astra", 1000));
    expect(codexPrice("gpt-6.2-sol", 1000)).toEqual(codexPrice("gpt-6.1-sol", 1000));
    expect(codexPrice("gpt-6-luna", 1000).input).toBe(0.1);
  });

  test("models before GPT-5.6 bill cache writes as input", () => {
    expect(codexPrice("gpt-5.5", 1000).cacheWriteShort).toBe(5);
    expect(codexPrice("gpt-5.6-sol", 1000).cacheWriteShort).toBe(5);
  });

  test("service tiers scale the Standard price", () => {
    expect(["default", "priority", "ultrafast", "flex", "other"].map(codexTierFactor)).toEqual([
      1, 2, 6, 0.5, 1,
    ]);
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

  test("many equal runs all teach the fit", async () => {
    const runs = 30;
    c.claudeSpending(
      "a",
      Array.from({ length: runs * 10 }, (_, i) => ({
        t: M - 7 * 86400 + 1800 * Math.floor(i / 10) + 60 * (i % 10),
        id: `r${i}`,
        model: "claude-opus-5-5",
        usage: opusOutput(1),
      })),
    );
    const use = await ledger();
    const rows = Array.from({ length: runs }, (_, k) => {
      const t0 = NOW - 7 * 86400 + 1800 * k - 60;
      const reset = R5 - 18000 * (runs - k);
      return [[t0, 0, reset] as const, [t0 + 600, 10, reset] as const];
    }).flat();
    expect(fitTokenCost(rows, use)).toEqual({
      pointsPerDollar: 1,
      runs,
      points: 10 * runs,
      dollars: 10 * runs,
    });
  });

  test("a run shorter than nine minutes, or across a drop in use, teaches nothing", async () => {
    lane("a", 60, 1);
    const use = await ledger();
    expect(
      fitTokenCost(
        [
          [NOW - 300, 0, R5],
          [NOW, 10, R5],
        ],
        use,
      ),
    ).toBeNull();
    // the window fell from 50 to 10 without its reset moving: only the stretch after the fall counts
    expect(
      fitTokenCost(
        [
          [NOW - 3660, 50, R5],
          [NOW - 1800, 10, R5],
          [NOW, 20, R5],
        ],
        use,
      ),
    ).toEqual({ pointsPerDollar: 10 / 29, runs: 1, points: 10, dollars: 29 }); // the 29 minutes after the fall
  });

  test("a run that began before the ledger knew every lane is left out", async () => {
    c.claudeSpending(
      "a",
      Array.from({ length: 30 }, (_, i) => ({
        t: M - 8 * 86400 - 900 + 60 * i,
        id: `e${i}`,
        model: "claude-opus-5-5",
        usage: opusOutput(1),
      })),
    );
    const use = await ledger();
    // its start predates the eight days the ledger keeps, so the costs it knows of it are partial
    expect(
      fitTokenCost(
        [
          [NOW - 8 * 86400 - 960, 0, R5 - 7 * 18000],
          [NOW - 8 * 86400 + 900, 10, R5 - 7 * 18000],
        ],
        use,
      ),
    ).toBeNull();
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
    // the running lanes go on until the reset, a new one for an hour
    expect(five.lane_headroom).toBe(Math.floor((97 - 30 - total * ((R5 - NOW) / 3600)) / mean));
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
    expect(five.lane_headroom).toBe(Math.floor((97 - 2 - rate * ((R5 - NOW) / 3600)) / rate));
  });

  test("a lane that has just started is averaged over five minutes, not one", async () => {
    c.claudeSpending("new", [{ t: M - 60, id: "n1", model: "claude-opus-5-5", usage: opusOutput(1) }]);
    const use = await ledger();
    const fit = { pointsPerDollar: 0.2, runs: 1, points: 20, dollars: 100 };
    expect(laneRates(use, fit, NOW)).toEqual([(1 * 0.2) / (300 / 3600)]);
  });

  test("a lane that spent nothing lately is not counted as burning", async () => {
    lane("a", 60, 1);
    c.claudeSpending("idle", [{ t: M - 120, id: "idle-0", model: "claude-opus-5-5", usage: opusOutput(0) }]);
    const use = await ledger();
    expect(laneRates(use, { pointsPerDollar: 0.2, runs: 1, points: 20, dollars: 100 }, NOW)).toHaveLength(1);
  });

  test("a week is paced by what its running lanes spend, not its window average", async () => {
    // a week at 88% with 62.9h left, 0.8%/h on average; it moved 3 points in the last 23 hours
    // while lane a spent evenly, so the lane burns about 0.13%/h
    const weekReset = Math.trunc(NOW + 62.9 * 3600);
    c.claude.seven_day = { utilization: 88, resets_at: iso(weekReset) };
    c.history("claude", "7d", [[NOW - 23 * 3600, 85]], weekReset);
    lane("a", 23 * 60, 0.1);
    const data = await c.json("claude");
    const week = (data.windows as Fields[])[1] as Fields;
    const each = (week.lane_rates as number[])[0] as number;
    expect([week.rate_basis, week.lane_basis, week.window_average_rate]).toEqual(["lanes", "tokens", 0.8]);
    expect(each).toBeCloseTo(0.13, 2);
    expect(week.status).toBe("on-target"); // by its window average it would end near 141%: slow down
    expect(week.lane_headroom).toBeGreaterThan(0);
    const out = await c.claudeOut("--state", c.copyState());
    expect(out).toContain("7d 88% 0.1%/h (lanes, window avg 0.8%/h) 62.9h left, ends ~96%");
    expect(out).not.toContain("slow down");
  });

  test("without a learned cost the lanes are shared out as before", async () => {
    (c.claude.five_hour as Fields).utilization = 30;
    lane("a", 60, 1);
    const five = ((await c.json("claude")).windows as Fields[])[0] as Fields;
    expect([five.lane_basis, five.lane_rates, five.token_cost]).toEqual([null, null, null]);
  });
});
