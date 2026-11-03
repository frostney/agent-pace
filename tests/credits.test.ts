// Usage credits, which the Python version did not read: once a window is at its limit, work
// draws on the account's credits (Claude's extra usage, Codex credits) until the window resets,
// so the lanes are paced against what is left of them instead of stopping. The Claude answers
// are shaped like the ones the usage endpoint (without skip_spend=1) and the prepaid balance
// endpoint gave for a real account on 3 Nov 2026, amounts changed.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { read } from "../src/history.ts";
import { Case, every, type Fields, iso, NOW, response } from "./harness.ts";

setDefaultTimeout(30_000);

let c: Case;

beforeEach(() => {
  c = new Case();
});

afterEach(() => {
  c.cleanup();
});

const ORG = "0d9e3c52-4a7b-4f1e-9c1d-2b6f8e5a7c31";

/** The extra_usage block of a plan with usage credits on: a spend limit of 10,000 GBP, 337.40 GBP spent. */
const EXTRA_USAGE: Fields = {
  is_enabled: true,
  monthly_limit: 1000000,
  used_credits: 33740,
  utilization: 3.374,
  currency: "GBP",
  decimal_places: 2,
  disabled_reason: null,
  user_disabled: false,
  spend_limit_reached: false,
  credits_ever_enabled: true,
  daily: null,
  weekly: null,
};

/** The prepaid balance: 429.39 GBP, less than the room under the spend limit, so it binds. */
const PREPAID: Fields = {
  amount: 42939,
  currency: "GBP",
  balance: { money: { amount_minor: 42939, currency: "GBP", exponent: 2 }, credits: null },
  auto_reload_settings: null,
};

/** Claude's week at its limit, resetting in 6 hours, with two lanes working; Claude Code's config names the organization. */
function claudeAtLimit(extra: Fields | null = EXTRA_USAGE): void {
  (c.claude.seven_day as Fields).utilization = 100;
  (c.claude.seven_day as Fields).resets_at = iso(NOW + 6 * 3600);
  c.claude.extra_usage = extra;
  c.prepaid = PREPAID;
  mkdirSync(join(c.dir, "claude-home"), { recursive: true });
  writeFileSync(
    join(c.dir, "claude-home", ".claude.json"),
    JSON.stringify({ oauthAccount: { organizationUuid: ORG } }),
  );
  c.laneHistory("claude", every(300, NOW - 1800, NOW, 2));
  c.claudeLanes(2);
}

/** Two earlier readings of what the credits have spent: 15 GBP drawn in each of the last two quarter hours. */
const drawing = () =>
  c.history(
    "claude",
    "credits",
    [
      [NOW - 1800, 307.4],
      [NOW - 900, 322.4],
    ],
    0,
  );

const prepaidRequests = () => c.requests.filter((r) => r.url.includes("/prepaid/credits"));

describe("UsageCredits", () => {
  test("a window at its limit with credits left has lane headroom on the credits", async () => {
    claudeAtLimit();
    drawing();
    // 15 GBP in the last quarter hour is 60 GBP/h over two lanes, 30 GBP/h each; the two go on
    // for the 6 hours until the week resets, a new lane is given an hour
    const expected = Math.floor((429.39 - 60 * 6) / (30 * 1));
    expect(expected).toBe(2);
    const out = await c.claudeOut();
    expect(out).toContain(
      `| 7d 100% 0.6%/h (window avg) 6.0h left, runs out in ~0.0h, even pace 0.0%/day -> on usage credits (429.39 GBP left): room for ~${expected} more lanes at 30.00 GBP/h each for 1.0h\n`,
    );
    const data = await c.json("claude");
    expect(data.lanes).toEqual({
      active: 2,
      headroom: expected,
      per_lane_rate: 30,
      window: "7d",
      hours: 1,
      pool: "usage-credits",
    });
    expect(data.usage_credits).toEqual({
      unit: "GBP",
      left: 429.39,
      drawing: true,
      hours_left: 6,
      rate_per_hour: 60,
      per_lane_rate: 30,
      lane_headroom: expected,
      lane_hours: 1,
    });
  });

  test("a window at its limit with no credits reads as before", async () => {
    claudeAtLimit(null);
    const out = await c.claudeOut();
    expect(out).toContain("no lane headroom: start nothing new");
    expect(out).not.toContain("usage credits");
    const data = await c.json("claude");
    expect([(data.lanes as Fields).headroom, (data.lanes as Fields).pool, data.usage_credits]).toEqual([
      0,
      "plan",
      null,
    ]);
    // nothing to draw on, so the balance is not asked for
    expect(prepaidRequests()).toEqual([]);
  });

  test("credits that ran out read as no credits", async () => {
    claudeAtLimit({ ...EXTRA_USAGE, is_enabled: false, disabled_reason: "out_of_credits" });
    const out = await c.claudeOut();
    expect(out).toContain("no lane headroom: start nothing new");
    expect(out).not.toContain("usage credits");
    expect((await c.json("claude")).usage_credits).toBeNull();
    expect(prepaidRequests()).toEqual([]);
  });

  test("credits that are used up to the balance read as no credits", async () => {
    claudeAtLimit();
    c.prepaid = { ...PREPAID, amount: 0 };
    expect(await c.claudeOut()).toContain("-> no lane headroom: start nothing new");
  });

  test("a balance that cannot be read leaves the credits unknown, and the reading as before", async () => {
    claudeAtLimit();
    c.prepaid = null; // 404
    const out = await c.claudeOut();
    expect(out).toContain("no lane headroom: start nothing new");
    expect((await c.json("claude")).usage_credits).toBeNull();
  });

  test("without a measured draw the credits are measuring, not nothing new", async () => {
    claudeAtLimit();
    const out = await c.claudeOut();
    expect(out).toContain("-> on usage credits (429.39 GBP left): measuring: start at most 1-2 new lanes");
    expect(out).not.toContain("no lane headroom");
    const data = await c.json("claude");
    expect([(data.lanes as Fields).headroom, (data.lanes as Fields).pool]).toEqual([null, "usage-credits"]);
  });

  test("the running lanes can spend what is left before the reset", async () => {
    claudeAtLimit();
    drawing();
    c.prepaid = { ...PREPAID, amount: 30000 }; // 300 GBP, less than 60 GBP/h for 6 hours
    expect(await c.claudeOut()).toContain(
      "-> on usage credits (300.00 GBP left): no lane headroom: start nothing new",
    );
  });

  test("what is left is the room under the spend limit when that is less than the balance", async () => {
    claudeAtLimit({ ...EXTRA_USAGE, monthly_limit: 40000 }); // 400 GBP, 62.60 GBP of it left
    drawing();
    expect(await c.claudeOut()).toContain("on usage credits (62.60 GBP left): no lane headroom");
  });

  test("auto-reload with no spend limit has nothing to pace against", async () => {
    claudeAtLimit({ ...EXTRA_USAGE, monthly_limit: null });
    drawing();
    c.prepaid = { ...PREPAID, auto_reload_settings: { enabled: true } };
    const out = await c.claudeOut();
    expect(out).toContain("-> on usage credits (no spend limit): measuring: start at most 1-2 new lanes");
    expect(((await c.json("claude")).usage_credits as Fields).left).toBeNull();
  });

  test("below the limit the credits do not change the lanes", async () => {
    claudeAtLimit();
    (c.claude.seven_day as Fields).utilization = 40;
    const out = await c.claudeOut();
    expect(out).not.toContain("usage credits");
    const data = await c.json("claude");
    expect((data.lanes as Fields).pool).toBe("plan");
    expect(data.usage_credits).toEqual({
      unit: "GBP",
      left: 429.39,
      drawing: false,
      hours_left: null,
      rate_per_hour: null,
      per_lane_rate: null,
      lane_headroom: null,
      lane_hours: null,
    });
  });

  test("the balance is read for the organization with the usage call's headers", async () => {
    claudeAtLimit();
    await c.claudeOut();
    const [req] = prepaidRequests();
    expect(req?.url).toBe(`https://api.anthropic.com/api/oauth/organizations/${ORG}/prepaid/credits`);
    expect(req?.headers.get("authorization")).toBe("Bearer test");
    expect(c.requests.length).toBe(2);
    c.env.CLAUDE_CODE_ORGANIZATION_UUID = "11111111-2222-3333-4444-555555555555";
    c.clock += 120; // past the one-minute cache
    await c.claudeOut();
    expect(prepaidRequests()[1]?.url).toContain("/organizations/11111111-2222-3333-4444-555555555555/");
  });

  test("each reading records what the credits have spent, and a cached one keeps them", async () => {
    claudeAtLimit();
    drawing();
    await c.claudeOut();
    expect(read(join(c.state, "claude-credits.csv")).at(-1)).toEqual([NOW, 337.4, 0]);
    const requests = c.requests.length;
    expect(await c.claudeOut()).toContain("on usage credits (429.39 GBP left): room for ~2 more lanes");
    expect(c.requests.length).toBe(requests); // read from the cache and its sidecar
  });

  test("plan sends work to the credits when neither plan has room", async () => {
    claudeAtLimit();
    drawing();
    c.serve(response({ used: 100, credits: [] }));
    const line = await c.planLine();
    expect(line).toBe(
      "Claude 7d at 100% and Codex 7d at 100%: neither plan has room; route work to Claude on usage credits " +
        "(429.39 GBP left), or wait for a reset (lanes: Claude on usage credits (429.39 GBP left): room for ~2 more " +
        "lanes at 30.00 GBP/h each for 1.0h; Codex no lane headroom: start nothing new)",
    );
    const data = JSON.parse((await c.runPace("plan", "--json"))[0]);
    expect(data.route).toBe("claude");
  });

  test("plan does not send work to credits with no lane headroom", async () => {
    claudeAtLimit();
    drawing();
    c.prepaid = { ...PREPAID, amount: 30000 }; // the running lanes spend it before the reset
    c.serve(response({ used: 100, credits: [] }));
    expect(await c.plan()).toBe("Claude 7d at 100% and Codex 7d at 100%: neither has room, wait for a reset");
    expect(JSON.parse((await c.runPace("plan", "--json"))[0]).route).toBe("none");
  });

  test("plan still prefers a provider with room in its plan", async () => {
    claudeAtLimit();
    drawing();
    c.serve(response({ used: 20, credits: [] }));
    const line = await c.planLine();
    expect(line.startsWith("Claude 7d at 100%: route work to Codex")).toBe(true);
    expect(line).toContain("; Claude on usage credits (429.39 GBP left): room for ~2 more lanes");
  });

  test("Codex credits pace a Codex window at its limit", async () => {
    const snapshot = response({ used: 100, credits: [], reset: NOW + 3600 });
    const limits = snapshot.result.rateLimits as Fields;
    limits.credits = { hasCredits: true, unlimited: false, balance: "1000.0000000000" };
    c.serve(snapshot);
    // 30 credits drawn in the last quarter hour: 120 credits/h over two lanes
    c.history(
      "codex",
      "credits",
      [
        [NOW - 1800, -1060],
        [NOW - 900, -1030],
      ],
      0,
    );
    c.laneHistory("codex", every(300, NOW - 1800, NOW, 2));
    c.codexLanes(2);
    const expected = Math.floor((1000 - 120 * 1) / (60 * 1));
    expect(await c.codex()).toContain(
      `-> on usage credits (1000.00 credits left): room for ~${expected} more lanes at 60.00 credits/h each for 1.0h`,
    );
    expect(read(join(c.state, "codex-credits.csv")).at(-1)).toEqual([NOW, -1000, 0]);
  });

  test("Codex without credits at its limit reads as before", async () => {
    const snapshot = response({ used: 100, credits: [], reset: NOW + 3600 });
    (snapshot.result.rateLimits as Fields).credits = { hasCredits: false, unlimited: false, balance: "0" };
    c.serve(snapshot);
    c.codexLanes(2);
    const out = await c.codex();
    expect(out).toContain("-> slow down\n");
    expect(out).not.toContain("usage credits");
    const data = await c.json("codex");
    expect([(data.lanes as Fields).headroom, (data.lanes as Fields).pool, data.usage_credits]).toEqual([
      0,
      "plan",
      null,
    ]);
  });

  test("Codex credits in the session logs count when the app server is unavailable", async () => {
    const path = c.sessionLog(100);
    writeFileSync(
      path,
      `${JSON.stringify({
        timestamp: "2025-10-22T11:25:30.000Z",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 100, window_minutes: 10080, resets_at: NOW + 3600 },
            secondary: null,
            credits: { has_credits: true, unlimited: false, balance: "250.5000000000" },
          },
        },
      })}\n`,
    );
    c.serve(response(), "fail");
    expect(await c.codex()).toContain("on usage credits (250.50 credits left)");
  });
});
