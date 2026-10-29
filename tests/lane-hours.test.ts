// Lane headroom over a finite stretch, which the Python version did not have: a new lane is
// counted for --lane-hours and then read again, the running lanes until the window resets (or,
// with a reset banked, until the next reading), and a week is paced by what its running lanes
// spend (tests/tokens.test.ts).
// Each case is one the Python version answered with "start nothing new" or "slow down".

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Case, CREDITS, every, type Fields, iso, NOW, RESET, response } from "./harness.ts";

setDefaultTimeout(30_000);

let c: Case;

beforeEach(() => {
  c = new Case();
});

afterEach(() => {
  c.cleanup();
});

const windows = (data: Fields) => data.windows as Fields[];

/** Codex at `used`, three points up on a reading 3 / perHour hours ago, with `lanes` counted every 5 minutes since. */
const codexBurn = (used: number, perHour: number, lanes: number, credits?: readonly Fields[]) => {
  c.serve(response({ used, ...(credits ? { credits } : {}) }));
  const since = NOW - (3 / perHour) * 3600;
  c.history("codex", "7d", [[since, used - 3]], RESET);
  c.laneHistory("codex", every(300, since, NOW, lanes));
  c.codexLanes(lanes);
};

describe("LaneHours", () => {
  test("a banked reset that expires first is a deadline to fill by, not a speed limit", async () => {
    codexBurn(63, 3.2, 2); // two lanes at 1.6%/h each, the first banked reset expiring in 35.8h
    const deadlineH = ((CREDITS[0]?.expiresAt as number) - 7200 - NOW) / 3600;
    // every lane until the deadline, as the Python version counted: nothing new
    expect(Math.max(0, Math.floor((100 - 63) / (1.6 * deadlineH) - 2))).toBe(0);
    // running out early is fine with a reset banked (it is redeemed then): every lane for the next hour
    const expected = Math.floor((100 - 63 - 3.2 * 1) / (1.6 * 1));
    expect(expected).toBe(21);
    const w = windows(await c.json("codex"))[0] as Fields;
    expect([w.per_lane_rate, w.lane_headroom, w.lane_hours]).toEqual([1.6, expected, 1]);
    expect(await c.codex()).toContain(`room for ~${expected} more lanes at 1.6%/h each for 1.0h`);
  });

  test("without a reset banked the running lanes still count until the reset", async () => {
    codexBurn(63, 3.2, 2, []);
    const w = windows(await c.json("codex"))[0] as Fields;
    // 63 + 3.2 * 139.8h is far past 97: nothing new, and slow down
    expect([w.lane_headroom, w.status]).toEqual([0, "over"]);
  });

  test("lane hours sets the hours a new lane is given", async () => {
    codexBurn(20, 0.4, 2, []);
    const leftH = (RESET - NOW) / 3600;
    for (const hours of [1, 4]) {
      const w = windows(await c.json("codex", "--lane-hours", String(hours)))[0] as Fields;
      expect([w.lane_headroom, w.lane_hours]).toEqual([
        Math.floor((97 - 20 - 0.4 * leftH) / (0.2 * hours)),
        hours,
      ]);
    }
  });

  test("lane hours must be more than 0", async () => {
    const [, err] = await c.runPace("codex", "--lane-hours", "0");
    expect([err.split("\n").at(-2), c.status]).toEqual([
      "agent-pace: error: argument --lane-hours: must be more than 0: '0'",
      2,
    ]);
  });

  test("a new lane is never given past the window's reset", async () => {
    codexBurn(20, 0.4, 2, []);
    c.serve(response({ used: 20, reset: NOW + 1800, credits: [] }));
    c.history("codex", "7d", [[NOW - (3 / 0.4) * 3600, 17]], NOW + 1800);
    const w = windows(await c.json("codex", "--lane-hours", "4"))[0] as Fields;
    expect(w.lane_hours).toBe(0.5);
  });

  test("an unmeasured window with a reset banked binds only if it could fill before the next reading", async () => {
    // the week at 60% after 50h (1.2%/h on average) has a reset banked and no lane estimate: even at
    // twice its average it stays far below 100% for the next hour, so the measured 5h window binds
    const r5 = Math.trunc(NOW + 4200);
    c.claude.five_hour = { utilization: 6, resets_at: iso(r5) };
    c.claude.seven_day = { utilization: 60, resets_at: iso(Math.trunc(NOW + 118 * 3600)) };
    const since = NOW - 0.3 * 3600;
    c.history("claude", "5h", [[since, 3]], r5);
    c.laneHistory("claude", every(300, since, NOW, 1));
    c.claudeLanes(1);
    c.grant({ ends_at: "2025-12-01T16:00:00+00:00" });
    const data = await c.json("claude");
    const week = windows(data)[1] as Fields;
    expect([week.lane_headroom, (week.banked as Fields).action]).toEqual([null, "fill"]);
    expect((data.lanes as Fields).window).toBe("5h"); // counted until the week's reset it would hold the source at measuring
    expect((data.lanes as Fields).headroom).toBe(7);
  });

  test("a week whose lane burn is only shared out keeps its window average", async () => {
    // a week at 88% with 62.9h left, 0.8%/h on average: the recent rate of a week's whole points
    // swings from reading to reading, so only the lanes' own tokens pace it (tests/tokens.test.ts)
    const weekReset = Math.trunc(NOW + 62.9 * 3600);
    c.claude.seven_day = { utilization: 88, resets_at: iso(weekReset) };
    const since = NOW - (3 / 0.13) * 3600;
    c.history("claude", "7d", [[since, 85]], weekReset);
    c.laneHistory("claude", every(300, since, NOW, 1));
    c.claudeLanes(1);
    const week = windows(await c.json("claude"))[1] as Fields;
    expect([week.rate_basis, week.status, week.lane_basis]).toEqual(["window-average", "over", "shared"]);
  });

  test("a week with no lanes running keeps its window average", async () => {
    c.claude.seven_day = { utilization: 88, resets_at: iso(Math.trunc(NOW + 62.9 * 3600)) };
    const week = windows(await c.json("claude"))[1] as Fields;
    expect([week.rate_basis, week.status, week.lane_headroom]).toEqual(["window-average", "over", 0]);
  });
});
