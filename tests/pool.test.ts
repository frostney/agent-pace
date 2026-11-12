// A hub pool's window as assess sees it, which the Python version did not have: accounts that
// reset before the pool hand back what they used, at their own reset; a reset banked on one
// account only needs that account filled before it expires; and slow down keeps lanes. Each
// case drives assess directly, with a day-long window paced by its average so far.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assess, type PaceOptions } from "../src/assess.ts";
import { poolBanked, poolMembers } from "../src/hub.ts";
import { recommend } from "../src/plan.ts";
import { Wording } from "../src/report.ts";
import type { Banked, HubAccount, LaneReading, UsageWindow } from "../src/usage.ts";

const NOW = 1_800_000_000;
const H = 3600;

let state: string;
let options: PaceOptions;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "agent-pace-pool-"));
  options = { target: 100, band: 3, plan: "fill", reserve: 10, redeemMargin: 2, laneHours: 1, state };
});

afterEach(() => {
  rmSync(state, { recursive: true, force: true });
});

/** A day-long pool window at `used`, resetting in leftH, with [hours from now, points] handed back. */
function day(used: number, leftH: number, returns: [number, number][] = []): UsageWindow {
  return {
    name: "1d",
    used,
    resetsAt: NOW + leftH * H,
    lengthS: 24 * H,
    observedAt: NOW,
    ...(returns.length > 0 ? { returns: returns.map(([h, p]) => [NOW + h * H, p] as const) } : {}),
  };
}

function hubAccount(
  label: string,
  windows: UsageWindow[],
  limits: string[],
  banked: Banked | null,
): HubAccount {
  return {
    label,
    plan: null,
    weight: null,
    state: "ok",
    detail: null,
    readAt: NOW,
    coolingDown: false,
    windows,
    limits,
    banked,
  };
}

const lanes = (active: number, rows: [number, number][] = []): LaneReading => ({ active, rows, at: NOW });

describe("PoolReturns", () => {
  test("a pool that runs dry before an account hands its window back says slow down", () => {
    // 90% at 90 / 21h = 4.29%/h: dry in 2.3h, before 30 points come back at 2.5h, though it would
    // end at 90 - 30 + 4.29 * 3 = 73%
    const [a] = assess("claude-pool", [day(90, 3, [[2.5, 30]])], options, null, null, NOW);
    expect([a?.status, a?.projectedAtReset, a?.laneHeadroom]).toEqual(["over", 73, 0]);
    expect(a?.dryHours).toBeCloseTo(10 / (90 / 21), 9);
  });

  test("slow down keeps the lanes that last to the first return, fewer than run", () => {
    // 20 lanes at 4.29 / 20 = 0.214%/h each: 10 points last floor(10 / (0.214 * 2.5)) = 18 of them
    // to the return at 2.5h; with the 40 points by the reset, 62 would fit
    const [a] = assess("claude-pool", [day(90, 3, [[2.5, 30]])], options, null, lanes(20), NOW);
    expect(a?.laneKeep).toBe(18);
  });

  test("lane headroom fits the room before each return, not only at the reset", () => {
    // the pool's burn measured at 4%/h over the last hour, shared by 2 lanes: 2%/h each
    writeFileSync(
      join(state, "claude-pool-1d.csv"),
      `${NOW - H},46.0,${NOW + 10 * H}\r\n${NOW},50.0,${NOW + 10 * H}\r\n`,
    );
    const counts = Array.from({ length: 13 }, (_, i) => [NOW - H + i * 300, 2] as [number, number]);
    const [a] = assess("claude-pool", [day(50, 10, [[8, 40]])], options, null, lanes(2, counts), NOW);
    // before the 40 points at 8h: (50 - 4 * 8) / 2 = 9 new lanes; by the reset (90 - 4 * 10) / 2 = 25
    expect([a?.perLaneRate, a?.laneHeadroom]).toEqual([2, 9]);
  });
});

describe("PoolBankedResets", () => {
  /** A reset banked on one account, expiring in 6h (a deadline 4h away), with `fill` of its account left. */
  const bankedWith = (fill: number): Banked => ({
    count: 1,
    credits: [{ expiresAt: NOW + 6 * H, title: null, clears: null, fill }],
  });

  test("an expiring reset only needs its account filled, and the pool lands on 100% at its reset", () => {
    // 50% at 50 / 14h = 3.57%/h: 14.3 points by the deadline fill the account's 10, though the
    // pool would be at 64%
    const [a] = assess("claude-pool", [day(50, 10)], options, bankedWith(10), null, NOW);
    expect([a?.status, a?.banked?.action, a?.banked?.rateNeeded, a?.rateNeededForTarget]).toEqual([
      "on-target",
      "fill",
      2.5,
      5,
    ]);
  });

  test("an account short of full at the rate now asks for work", () => {
    // 14.3 points by the deadline at 3.57%/h, 14.5 to fill: short now, but within reach at the
    // 6%/h peak seen over an hour of this window
    writeFileSync(
      join(state, "claude-pool-1d.csv"),
      `${NOW - 2 * H},40.0,${NOW + 10 * H}\r\n${NOW - H},46.0,${NOW + 10 * H}\r\n`,
    );
    const [a] = assess("claude-pool", [day(50, 10)], options, bankedWith(14.5), null, NOW);
    expect([a?.status, a?.banked?.action, a?.banked?.peakRate]).toEqual(["under", "fill", 6]);
  });

  test("a reset that outlasts the pool's window is filled by its reset, counting what comes back", () => {
    // 50%, 20 points back at 4h: 70 points to fill by the reset in 10h; at 3.57%/h it ends at
    // 50 - 20 + 35.7 = 66%
    const banked: Banked = { count: 1, credits: [{ expiresAt: NOW + 48 * H, title: null, clears: null }] };
    const [a] = assess("claude-pool", [day(50, 10, [[4, 20]])], options, banked, null, NOW);
    expect([a?.banked?.mode, a?.banked?.rateNeeded, a?.banked?.projectedAtDeadline]).toEqual([
      "reset",
      7,
      66,
    ]);
  });

  test("an account already at its limit is redeemed, and plan says the account is, not the provider", () => {
    const res = assess("claude-pool", [day(50, 10)], options, bankedWith(0), null, NOW);
    expect([res[0]?.status, res[0]?.banked?.action]).toEqual(["on-target", "redeem"]);
    const [route, redeem, text] = recommend({ claude: res }, {}, 10, new Wording("UTC"), new Set(["claude"]));
    expect([route, redeem]).toEqual(["claude", true]);
    expect(text).toStartWith(
      "a Claude hub account is at its limit: redeem its banked reset on the hub (1 left, ",
    );
  });

  test("a reset only clears the windows its account's plan limits", () => {
    const banked = poolBanked({
      url: "https://hub.test",
      observedAt: NOW,
      accounts: [
        hubAccount(
          "session only",
          [{ name: "5h", used: 40, resetsAt: NOW + 2 * H, lengthS: 5 * H, observedAt: NOW }],
          ["5h"],
          {
            count: 1,
            credits: [{ expiresAt: NOW + 24 * H, title: null, clears: ["5h", "7d"] }],
          },
        ),
        hubAccount(
          "weekly",
          [{ name: "7d", used: 60, resetsAt: NOW + 72 * H, lengthS: 168 * H, observedAt: NOW }],
          ["7d"],
          {
            count: 0,
            credits: [],
          },
        ),
      ],
    });
    expect(banked?.credits?.map((c) => c.clears)).toEqual([["5h"]]);
  });

  test("no reset on the accounts read is no reset known while another's are unknown", () => {
    const pool = (second: Banked | null) =>
      poolBanked({
        url: "https://hub.test",
        observedAt: NOW,
        accounts: [
          hubAccount("a", [], ["7d"], { count: 0, credits: [] }),
          hubAccount("b", [], ["7d"], second),
        ],
      });
    expect(pool(null)).toBeNull();
    expect(pool({ count: 0, credits: [] })).toEqual({ count: 0, credits: [] });
  });

  test("an account gaining or losing a window's limit starts the pool's history over", () => {
    const members = (limits: string[]) =>
      poolMembers({
        url: "https://hub.test",
        observedAt: NOW,
        accounts: [hubAccount("a", [], limits, null)],
      });
    expect(members(["5h", "7d"])).not.toBe(members(["7d"]));
  });

  test("an account that has not started the window the reset clears has all of it to fill", () => {
    const account = (label: string, windows: UsageWindow[], expiresInH: number): HubAccount => ({
      label,
      plan: null,
      weight: null,
      state: "ok",
      detail: null,
      readAt: NOW,
      coolingDown: false,
      windows,
      limits: ["7d"],
      banked: { count: 1, credits: [{ expiresAt: NOW + expiresInH * H, title: null, clears: ["7d"] }] },
    });
    const week = { name: "7d", used: 60, resetsAt: NOW + 72 * H, lengthS: 168 * H, observedAt: NOW };
    const banked = poolBanked({
      url: "https://hub.test",
      observedAt: NOW,
      accounts: [account("busy", [week], 48), account("idle", [], 24)],
    });
    // each is half the pool: busy has 40% of its own left, idle all of it
    expect(banked?.credits?.map((c) => c.fill)).toEqual([20, 50]);
  });

  test("a pooled reset is at risk by its own account's reset, not the pool's", () => {
    // the pool resets in 10h; the reset expires in 30h, before its account's own window resets
    // in 48h: at risk, though it outlasts the pool's reset
    const late: Banked = {
      count: 1,
      credits: [
        { expiresAt: NOW + 30 * H, title: null, clears: null, fill: 10, ownerResetsAt: NOW + 48 * H },
      ],
    };
    expect(assess("claude-pool", [day(50, 10)], options, late, null, NOW)[0]?.banked?.mode).toBe("expiry");
    // its account is full but refills on its own in an hour, a day before the reset expires: not
    // at risk, so it is kept, as on one login
    const refills: Banked = {
      count: 1,
      credits: [{ expiresAt: NOW + 24 * H, title: null, clears: null, fill: 0, ownerResetsAt: NOW + H }],
    };
    const [a] = assess("claude-pool", [day(50, 10)], options, refills, null, NOW);
    expect([a?.banked?.mode, a?.banked?.action]).toEqual(["reset", "fill"]);
  });

  test("a pooled reset on an account that has not started its window is always at risk", () => {
    const idle = poolBanked({
      url: "https://hub.test",
      observedAt: NOW,
      accounts: [
        hubAccount("idle", [], ["1d"], {
          count: 1,
          credits: [{ expiresAt: NOW + 30 * H, title: null, clears: null }],
        }),
        hubAccount("busy", [day(50, 10)], ["1d"], { count: 0, credits: [] }),
      ],
    });
    // it expires after the pool's reset in 10h, but the idle account has no reset of its own
    const [a] = assess("claude-pool", [day(25, 10)], options, idle, null, NOW);
    expect([a?.banked?.mode, a?.banked?.expiresInH]).toEqual(["expiry", 30]);
  });

  test("the expiry shown is the one at risk", () => {
    // a reset expiring in 5h on an account that refills in 1h is safe; the one at risk expires in 8h
    const two: Banked = {
      count: 2,
      credits: [
        { expiresAt: NOW + 5 * H, title: null, clears: null, fill: 0, ownerResetsAt: NOW + H },
        { expiresAt: NOW + 8 * H, title: null, clears: null, fill: 10, ownerResetsAt: NOW + 48 * H },
      ],
    };
    const [a] = assess("claude-pool", [day(50, 10)], options, two, null, NOW);
    expect([a?.banked?.mode, a?.banked?.expiresInH, a?.banked?.hoursToDeadline]).toEqual(["expiry", 8, 6]);
  });

  test("a pool at its limit redeems a reset only once its own account is full", () => {
    // the pool at 98% with --target 97; the reset outlasts its account's reset, which has 10 points left
    options = { ...options, target: 97 };
    const room = (fill: number): Banked => ({
      count: 1,
      credits: [{ expiresAt: NOW + 48 * H, title: null, clears: null, fill, ownerResetsAt: NOW + 20 * H }],
    });
    expect(assess("claude-pool", [day(98, 10)], options, room(10), null, NOW)[0]?.banked?.action).toBe(
      "fill",
    );
    expect(assess("claude-pool", [day(98, 10)], options, room(0), null, NOW)[0]?.banked?.action).toBe(
      "redeem",
    );
  });

  test("a pool near its limit redeems a pooled reset only once its account is full", () => {
    // the pool at 98% with --target 97, but the reset's account still has 2 points to fill
    options = { ...options, target: 97 };
    const [a] = assess("claude-pool", [day(98, 10)], options, bankedWith(2), null, NOW);
    expect(a?.banked?.action).toBe("fill");
  });
});
