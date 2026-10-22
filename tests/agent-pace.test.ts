// The parity suite: the Python version's tests/agent-pace.py, test for test, against the same
// recorded responses. Each describe block is one of its unittest classes.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { recentRate } from "../src/assess.ts";
import { CLAUDE_CLI_FALLBACK, claudeCliVersion } from "../src/claude.ts";
import { codexWindow } from "../src/codex.ts";
import { read } from "../src/history.ts";
import { activeLanes } from "../src/lanes.ts";
import { roundTo } from "../src/python-format.ts";
import { Case, CREDITS, compact, every, type Fields, iso, NOW, RESET, response } from "./harness.ts";

setDefaultTimeout(30_000);

let c: Case;

beforeEach(() => {
  c = new Case();
});

afterEach(() => {
  c.cleanup();
});

type Json = Fields & Record<string, unknown>;
const windows = (data: Json) => data.windows as Json[];
const first = (data: Json) => windows(data)[0] as Json;
const banked = (w: Json) => w.banked as Json;

describe("CodexBankedResets", () => {
  test("recorded example is on track for the first expiry", async () => {
    const out = await c.codex();
    expect(out).toContain(
      "banked reset expires Fri 24 Oct 00:10 (in 35.8h): fill to 100% by then (needs 0.9%/h, now 2.4%/h), then redeem it [3 banked]",
    );
    expect(out).toContain("(0.9%/h lands on 100%)");
    expect(out).toContain("-> keep going");
    expect(out).not.toContain("slow down");
  });

  test("only the read calls are made", async () => {
    await c.codex();
    expect(c.methods()).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  });

  test("credit before the reset while behind asks for work", async () => {
    c.serve(response({ used: 20 }));
    c.history("codex", "7d", [
      [NOW - 7200, 14],
      [NOW - 60, 20],
    ]); // it has burned 3%/h before
    const out = await c.codex();
    expect(out).toContain("fill to 100% by then (needs 2.4%/h, now 0.7%/h), then redeem it");
    expect(out).toContain("-> room left: add work");
    const w = first(await c.json("codex"));
    expect([w.target, w.status, w.rate_needed_for_target]).toEqual([100, "under", 2.4]);
    expect(banked(w).mode).toBe("expiry");
    expect(banked(w).action).toBe("fill");
  });

  test("redeem margin moves the deadline", async () => {
    expect(await c.codex("--redeem-margin", "30")).toContain("needs 5.6%/h");
  });

  test("unreachable expiry proposes redeeming anyway", async () => {
    const credits = [{ ...CREDITS[0], expiresAt: NOW + 10 * 3600 }, ...CREDITS.slice(1)];
    c.serve(response({ used: 20, credits }));
    const out = await c.codex();
    expect(out).toContain(
      "cannot reach 100% by then (needs 10.0%/h, peak seen 0.7%/h); redeem it anyway by Wed 22 Oct 20:25, an unused reset is lost",
    );
    expect(banked(first(await c.json("codex"))).action).toBe("redeem-anyway");
    expect(out).toContain("Wed 22 Oct 22:25 (in 10.0h)");
  });

  test("expiry inside the margin says redeem now", async () => {
    const credits = [{ ...CREDITS[0], expiresAt: NOW + 3600 }, ...CREDITS.slice(1)];
    c.serve(response({ used: 20, credits }));
    expect(await c.codex()).toContain(
      "too close to reach 100% (at 20%); redeem it now, an unused reset is lost",
    );
  });

  test("credits only after the reset target 100 at the reset without slowing down", async () => {
    c.serve(response({ credits: CREDITS.slice(1) }));
    const out = await c.codex();
    expect(out).toContain(
      "2 banked resets, none expiring before the 7d window resets (next expires Thu 30 Oct 17:39): " +
        "fill to 100% by the reset (needs 0.2%/h, now 2.4%/h), then redeem one",
    );
    expect(out).not.toContain("slow down");
    expect(out).toContain("lands on 100%");
  });

  test("no reserve taper with credits after the reset", async () => {
    c.serve(response({ used: 95, credits: CREDITS.slice(1) }));
    const out = await c.codex();
    expect(out).not.toContain("slow down");
    expect(out).not.toContain("capped");
  });

  test("null credits with a count are banked with unknown expiry", async () => {
    c.serve(response({ credits: null, count: 2 }));
    const out = await c.codex();
    expect(out).toContain("2 banked resets, none expiring before the 7d window resets (expiry unknown)");
    expect(out).not.toContain("slow down");
    const data = await c.json("codex");
    expect(data.banked_resets).toEqual({
      known: true,
      count: 2,
      credits: null,
      via: "app-server",
      note: null,
    });
  });

  test("credits shorter than the count still count the rest", async () => {
    c.serve(response({ credits: CREDITS.slice(1, 2), count: 3 }));
    const out = await c.codex();
    expect(out).toContain("3 banked resets");
    expect(out).toContain("next expires Thu 30 Oct 17:39");
  });

  test("a credit that never expires is not at risk", async () => {
    c.serve(response({ credits: [{ ...CREDITS[0], expiresAt: null }] }));
    expect(await c.codex()).toContain(
      "1 banked reset, none expiring before the 7d window resets (none expire)",
    );
  });

  test("only available codex credits are listed", async () => {
    const credits = [
      { ...CREDITS[0], status: "redeemed" },
      { ...CREDITS[1], resetType: "unknown" },
      CREDITS[2] as Fields,
    ];
    c.serve(response({ credits, count: 1 }));
    const listed = (await c.json("codex")).banked_resets as Json;
    const expiries = (listed.credits as Json[]).map((x) => x.expires_at);
    expect(expiries).toEqual([iso(CREDITS[2]?.expiresAt as number).replace("Z", "+00:00")]);
  });

  test("no credits behaves as before", async () => {
    c.serve(response({ credits: [] }));
    const out = await c.codex();
    expect(out).not.toContain("banked");
    expect(out).toContain("-> slow down");
    const w = first(await c.json("codex"));
    expect([w.target, w.status, w.banked]).toEqual([97, "over", null]);
  });

  test("at the limit says to redeem", async () => {
    c.serve(response({ used: 98 }));
    expect(await c.codex()).toContain(
      "at limit: redeem a banked reset (3 left, next expires Fri 24 Oct 00:10)",
    );
  });

  test("a low target does not make 65 percent the limit", async () => {
    c.serve(response({ used: 65 }));
    const out = await c.codex("--target", "60");
    expect(out).not.toContain("at limit");
    expect(out).toContain("banked reset expires");
  });

  test("an expired credit is not banked", async () => {
    c.serve(response({ credits: [{ ...CREDITS[0], expiresAt: NOW - 100 }, ...CREDITS.slice(1)] }));
    expect(await c.codex()).toContain("2 banked resets, none expiring before the 7d window resets");
  });

  test("expiry in the wrong unit falls back to the logs", async () => {
    c.sessionLog();
    c.serve(response({ credits: [{ ...CREDITS[0], expiresAt: (CREDITS[0]?.expiresAt as number) * 1000 }] }));
    expect(await c.codex()).toContain("banked resets unknown (Codex app server unavailable");
  });

  test("a missing credit summary is not blamed on the server", async () => {
    c.serve(response({ summary: false }));
    const out = await c.codex();
    expect(out).toContain("banked resets unknown (the Codex app server reported none)");
    expect(out).not.toContain("unavailable");
    const data = (await c.json("codex")).banked_resets as Json;
    expect([data.known, data.via]).toEqual([false, "app-server"]);
  });

  test("alerts only speaks for a due redemption", async () => {
    c.serve(response({ used: 98 }));
    expect(await c.codex("--alerts-only")).toContain("at limit");
    c.serve(response({ used: 68 }));
    expect(await c.codex("--alerts-only")).toBe("");
  });

  test("json keeps the existing fields", async () => {
    const data = await c.json("codex");
    expect(data.source).toBe("codex");
    const w = first(data);
    for (const key of [
      "window",
      "used",
      "resets_at",
      "hours_left",
      "rate_per_hour",
      "rate_basis",
      "projected_at_reset",
      "target",
      "rate_needed_for_target",
      "status",
      "note",
      "even_pace_per_day",
      "previous_window_ended_at",
      "observed_at",
    ]) {
      expect(Object.keys(w)).toContain(key);
    }
    const resets = data.banked_resets as Json;
    expect(resets.count).toBe(3);
    expect((resets.credits as Json[])[0]?.expires_at).toBe("2025-10-23T23:10:48+00:00");
  });
});

describe("CodexFallsBackToSessionLogs", () => {
  const checkFallback = async () => {
    c.sessionLog();
    const out = await c.codex();
    expect(out).toContain("codex: 7d 68%");
    expect(out).toContain("banked resets unknown (Codex app server unavailable; read the session logs)");
    expect(out).toContain("-> slow down"); // nothing banked is known, so the pacing is unchanged
    const data = await c.json("codex");
    expect(data.banked_resets).toEqual({
      known: false,
      count: null,
      credits: null,
      via: "session-logs",
      note: "banked resets unknown (Codex app server unavailable; read the session logs)",
    });
    expect(first(data).target).toBe(97);
  };

  test("server exits with an error", async () => {
    c.serve(response(), "fail");
    await checkFallback();
  });

  test("server answers with an error", async () => {
    c.serve(response(), "error");
    await checkFallback();
  });

  test("server answers garbage", async () => {
    c.serve(response(), "garbage");
    await checkFallback();
  });

  test("server hangs and is terminated", async () => {
    c.serve(response(), "hang");
    c.appServerTimeoutS = 1;
    const started = performance.now();
    await checkFallback();
    expect(performance.now() - started).toBeLessThan(20_000);
    const pid = Number(readFileSync(c.paths.pid, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("codex is not installed", async () => {
    c.remove("bin/codex");
    await checkFallback();
  });

  test("a response without windows falls back", async () => {
    const resp = response();
    (resp.result.rateLimits as Fields).primary = null;
    resp.result.rateLimitsByLimitId = null;
    c.serve(resp);
    await checkFallback();
  });

  test("no snapshot anywhere exits with the existing message", async () => {
    c.serve(response(), "fail");
    const [, err] = await c.runPace("codex");
    expect(err).toContain("no Codex rate-limit snapshot found");
  });
});

describe("ClaudeBankedResets", () => {
  test("the request is the one claude code makes", async () => {
    await c.claudeOut();
    const req = c.requests[0];
    expect(req?.url).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
    expect(req?.headers.get("user-agent")).toBe("claude-cli/2.1.999 (external, cli)");
    expect(req?.headers.get("x-app")).toBe("cli");
    expect(c.requests.length).toBe(1);
  });

  test("version falls back without claude and is remembered", () => {
    const host = c.host();
    expect(claudeCliVersion(c.state, host)).toBe("2.1.999");
    // the Python test relied on the wall clock staying within a day of the fixed NOW
    utimesSync(join(c.state, "claude-cli-version"), NOW - 60, NOW - 60);
    c.remove("bin/claude");
    expect(claudeCliVersion(c.state, host)).toBe("2.1.999"); // remembered
    rmSync(join(c.state, "claude-cli-version"));
    expect(claudeCliVersion(c.state, host)).toBe(CLAUDE_CLI_FALLBACK);
  });

  test("a used grant banks nothing", async () => {
    const out = await c.claudeOut();
    expect(out).not.toContain("banked");
    expect(out).not.toContain("/limit-reset");
    const data = await c.json("claude"); // served from the cache, banked resets included
    expect(data.banked_resets).toEqual({ known: true, count: 0, credits: [], via: "usage-api", note: null });
    expect(windows(data).map((w) => w.banked)).toEqual([null, null]);
  });

  test("a full grant expiring before the reset is filled on the 7d window", async () => {
    c.grant({ ends_at: "2025-10-23T16:00:00+00:00" });
    (c.claude.seven_day as Fields).utilization = 90;
    const out = await c.claudeOut();
    expect(out).toContain(
      "banked 7d reset expires Thu 23 Oct 17:00 (in 28.6h): fill to 100% by then (needs 0.4%/h, now 1.2%/h), " +
        "then run /limit-reset in Claude Code",
    );
    expect(out).not.toContain("5h reset expires");
    const data = await c.json("claude");
    expect(windows(data).map((w) => w.target)).toEqual([97, 100]);
    expect(((data.banked_resets as Json).credits as Json[])[0]?.clears).toEqual(["5h", "7d"]);
  });

  test("banked claude resets do not slow down or taper", async () => {
    c.grant({ ends_at: "2025-12-01T16:00:00+00:00" });
    let out = "";
    for (const used of [80, 95]) {
      (c.claude.seven_day as Fields).utilization = used;
      out = await c.claudeOut("--state", c.scratchState());
      expect(out).not.toContain("slow down");
      expect(out).not.toContain("even pace");
    }
    expect(out).toContain("1 banked 7d reset, none expiring before the 7d window resets");
    expect(out).toContain("then run /limit-reset in Claude Code");
  });

  test("without a grant the same week slows down and tapers", async () => {
    (c.claude.seven_day as Fields).utilization = 80;
    expect(await c.claudeOut()).toContain("-> slow down");
    (c.claude.seven_day as Fields).utilization = 95;
    expect(await c.claudeOut("--state", c.scratchState())).toContain("even pace");
  });

  test("a session grant only lifts the 5h target", async () => {
    c.grant({ type: "session", clears: ["five_hour"], ends_at: "2025-10-22T14:00:00+00:00" }); // after the 5h reset
    (c.claude.seven_day as Fields).utilization = 95;
    const [five, seven] = windows(await c.json("claude")) as [Json, Json];
    expect([five.target, banked(five).mode]).toEqual([100, "reset"]);
    expect(seven.banked).toBeNull();
    expect(seven.status).toBe("info"); // still tapering: the grant does not touch the week
    expect(await c.claudeOut()).toContain("1 banked 5h reset, none expiring before the 5h window resets");
  });

  test("the 5h window is not tapered while a week reset is banked", async () => {
    const r5 = Math.trunc(NOW + 4200);
    const r7 = Math.trunc(NOW + 4 * 86400);
    (c.claude.seven_day as Fields).utilization = 95;
    c.history(
      "claude",
      "5h",
      [
        [NOW - 3000, 10],
        [NOW - 120, 20],
      ],
      r5,
    );
    c.history(
      "claude",
      "7d",
      [
        [NOW - 3000, 91],
        [NOW - 120, 95],
      ],
      r7,
    );
    expect(await c.claudeOut("--state", c.copyState())).toContain("capped by 7d"); // without a grant it tapers
    c.grant({ ends_at: "2025-12-01T16:00:00+00:00" });
    const out = await c.claudeOut("--state", c.copyState());
    expect(out).not.toContain("capped");
    expect(out).toContain("lands on 97.0%");
  });

  test("grants without clears follow their type", async () => {
    for (const [kind, cleared] of [
      ["session", ["5h"]],
      ["weekly", ["5h", "7d"]],
    ] as const) {
      c.grant({ type: kind, ends_at: "2025-12-01T16:00:00+00:00" });
      const grants = (c.claude.cedar_ember as Fields).grants as Fields[];
      delete grants[0]?.clears;
      const data = await c.json("claude", "--state", c.scratchState());
      expect(((data.banked_resets as Json).credits as Json[])[0]?.clears).toEqual([...cleared]);
    }
  });

  test("a grant that clears nothing tracked is ignored", async () => {
    c.grant({ ends_at: "2025-12-01T16:00:00+00:00", clears: ["seven_day_opus"] });
    expect(((await c.json("claude")).banked_resets as Json).count).toBe(0);
  });

  test("a grant without an end never expires", async () => {
    c.grant({ ends_at: null });
    (c.claude.seven_day as Fields).utilization = 80;
    expect(await c.claudeOut()).toContain(
      "1 banked 7d reset, none expiring before the 7d window resets (none expire)",
    );
  });

  test("a paused grant is not banked", async () => {
    c.grant({ ends_at: "2025-10-23T16:00:00+00:00", paused: true });
    expect(await c.claudeOut()).not.toContain("banked");
  });

  test("at the limit points at limit reset", async () => {
    c.grant({ ends_at: "2025-10-23T16:00:00+00:00" });
    (c.claude.seven_day as Fields).utilization = 98;
    expect(await c.claudeOut()).toContain(
      "at limit: run /limit-reset in Claude Code (1 left, 7d window, next expires Thu 23 Oct 17:00)",
    );
  });

  test("ineligible for a reason that means none", async () => {
    c.claude.cedar_ember = {
      eligible: false,
      ineligible_reason: "tenure",
      at_limit: true,
      exhausted: ["seven_day"],
      grants: [],
    };
    const data = (await c.json("claude")).banked_resets as Json;
    expect([data.known, data.count]).toEqual([true, 0]);
  });

  test("ineligible because of the surface is unknown", async () => {
    c.claude.cedar_ember = { eligible: false, ineligible_reason: "surface", grants: [] };
    const out = await c.claudeOut();
    expect(out).toContain("Claude banked resets unknown (the usage endpoint says surface)");
    expect(out).toContain("claude: 5h");
    expect(((await c.json("claude")).banked_resets as Json).known).toBe(false);
  });

  test("missing or null cedar_ember leaves the pacing alone", async () => {
    for (const value of [null, "absent"]) {
      (c.claude.seven_day as Fields).utilization = 80;
      if (value === null) {
        c.claude.cedar_ember = null;
      } else {
        delete c.claude.cedar_ember;
      }
      const [out] = await c.runPace("claude", "--state", c.scratchState());
      expect(out).toContain("-> slow down");
      expect(out).not.toContain("banked");
    }
  });

  test("a cached reading keeps the banked resets", async () => {
    c.grant({ ends_at: "2025-10-23T16:00:00+00:00" });
    const once = await c.claudeOut();
    const twice = await c.claudeOut();
    expect(c.requests.length).toBe(1);
    expect(once).toContain("banked 7d reset expires");
    expect(twice).toContain("banked 7d reset expires");
  });
});

describe("RedeemMargin", () => {
  // Redeeming at the limit wastes the reset when the window resets on its own within --redeem-margin.
  const codexAtLimit = (secondsToReset: number, extra: Parameters<typeof response>[0] = {}) => {
    c.serve(response({ used: 98, reset: NOW + secondsToReset, ...extra }));
  };

  test("codex just inside the margin keeps the reset", async () => {
    codexAtLimit(7199);
    const out = await c.codex();
    expect(out).toContain(
      "at limit, but the 7d window resets on its own in 2.0h: keep the banked reset (3 left, next expires Fri 24 Oct 00:10)",
    );
    expect(out).not.toContain("redeem");
    expect(banked(first(await c.json("codex"))).action).toBe("wait");
  });

  test("exactly the margin keeps the reset", async () => {
    codexAtLimit(7200);
    expect(await c.codex()).toContain("keep the banked reset");
  });

  test("codex just outside the margin says redeem", async () => {
    codexAtLimit(7201);
    expect(await c.codex()).toContain(
      "at limit: redeem a banked reset (3 left, next expires Fri 24 Oct 00:10)",
    );
  });

  test("the margin is the flag", async () => {
    codexAtLimit(3600);
    expect(await c.codex()).toContain("keep the banked reset");
    expect(await c.codex("--redeem-margin", "0.5")).toContain("at limit: redeem a banked reset");
  });

  test("no alert inside the margin but one outside", async () => {
    codexAtLimit(7199);
    expect(await c.codex("--alerts-only")).toBe("");
    codexAtLimit(7201);
    expect(await c.codex("--alerts-only")).toContain("at limit: redeem");
  });

  test("a reset that expires before the window does is still redeemed", async () => {
    codexAtLimit(3600, { credits: [{ ...CREDITS[0], expiresAt: NOW + 1800 }, ...CREDITS.slice(1)] });
    expect(await c.codex()).toContain("at limit: redeem a banked reset");
  });

  test("plan treats the waiting window as full", async () => {
    codexAtLimit(7199);
    expect(await c.plan()).toBe("Codex 7d at 98%: route work to Claude");
    codexAtLimit(7201);
    expect((await c.plan()).startsWith("Codex is at its limit: redeem a banked reset")).toBe(true);
  });

  test("plan does not fill a claude 5h window that is waiting", async () => {
    c.grant({ type: "session", clears: ["five_hour"], ends_at: "2025-12-01T16:00:00+00:00" });
    c.claude.five_hour = { utilization: 98, resets_at: iso(NOW + 3600) };
    expect(await c.claudeOut()).toContain("keep the banked reset");
    expect(await c.plan()).toBe("Claude 5h at 98%: route work to Codex");
  });

  const claudeAtLimit = (secondsToReset: number) => {
    c.grant({ ends_at: "2025-12-01T16:00:00+00:00" });
    c.claude.seven_day = { utilization: 98, resets_at: iso(NOW + secondsToReset) };
  };

  test("claude just inside the margin keeps the grant", async () => {
    claudeAtLimit(7199);
    const out = await c.claudeOut();
    expect(out).toContain(
      "at limit, but the 7d window resets on its own in 2.0h: keep the banked reset (1 left, next expires Mon 1 Dec 16:00)",
    );
    expect(out).not.toContain("/limit-reset");
    expect(await c.claudeOut("--alerts-only", "--state", c.scratchState())).toBe("");
  });

  test("claude just outside the margin says limit reset", async () => {
    claudeAtLimit(7201);
    const out = await c.claudeOut();
    expect(out).toContain(
      "at limit: run /limit-reset in Claude Code (1 left, 7d window, next expires Mon 1 Dec 16:00)",
    );
    expect(await c.claudeOut("--alerts-only", "--state", c.scratchState())).toContain("at limit");
  });
});

describe("Lanes", () => {
  // How many more lanes the headroom supports, from the burn each active lane has caused.

  /** Codex at `used`, three points up on a reading 3 / perHour hours ago, with `lanes` counted every 5 minutes since. */
  const codexBurn = (
    used: number,
    perHour: number,
    lanes: number,
    options: { reset?: number; credits?: readonly Fields[] } = {},
  ) => {
    const reset = options.reset ?? RESET;
    c.serve(response({ used, reset, ...(options.credits ? { credits: options.credits } : {}) }));
    const since = NOW - (3 / perHour) * 3600;
    c.history("codex", "7d", [[since, used - 3]], reset);
    c.laneHistory("codex", every(300, since, NOW, lanes));
    c.codexLanes(lanes);
    return since;
  };

  /** Claude with both windows measured: each three points up on a reading 3 / burn per hour hours ago. */
  const claudeWindowsMeasured = (
    five: number,
    seven: number,
    options: { fiveUsed?: number; sevenUsed?: number; lanes?: number } = {},
  ) => {
    const { fiveUsed = 6, sevenUsed = 40, lanes = 1 } = options;
    const r5 = Math.trunc(NOW + 4200);
    const r7 = Math.trunc(NOW + 4 * 86400);
    (c.claude.five_hour as Fields).utilization = fiveUsed;
    (c.claude.seven_day as Fields).utilization = sevenUsed;
    const since5 = NOW - (3 / five) * 3600;
    const since7 = NOW - (3 / seven) * 3600;
    c.history("claude", "5h", [[since5, fiveUsed - 3]], r5);
    c.history("claude", "7d", [[since7, sevenUsed - 3]], r7);
    c.laneHistory("claude", every(300, Math.min(since5, since7), NOW, lanes));
    c.claudeLanes(lanes);
  };

  test("lanes running with headroom", async () => {
    codexBurn(20, 0.6, 2);
    const deadlineH = ((CREDITS[0]?.expiresAt as number) - 7200 - NOW) / 3600; // the first reset is filled 2h before it expires
    const expected = Math.floor((100 - 20) / (0.3 * deadlineH) - 2);
    expect(expected).toBe(5);
    const out = await c.codex();
    expect(out).toContain(`-> room left: add work (room for ~${expected} more lanes at 0.3%/h each)`);
    const lanes = await c.json("codex");
    const w = first(lanes);
    expect([w.active_lanes, w.per_lane_rate, w.lane_headroom]).toEqual([2, 0.3, expected]);
    expect(lanes.lanes).toEqual({ active: 2, headroom: expected, per_lane_rate: 0.3, window: "7d" });
  });

  test("a banked reset raises the aim", async () => {
    const results: Record<string, unknown> = {};
    for (const [name, credits] of [
      ["banked", CREDITS.slice(1)],
      ["none", []],
    ] as const) {
      // a reset after the window's own: aim 100, else 97
      codexBurn(20, 0.1416, 1, { credits });
      results[name] = first(await c.json("codex", "--state", c.copyState())).lane_headroom;
    }
    const leftH = (RESET - NOW) / 3600;
    expect(results.banked).toBe(Math.floor(80 / (0.1416 * leftH) - 1));
    expect(results.none).toBe(Math.floor(77 / (0.1416 * leftH) - 1));
    expect([results.none, results.banked]).toEqual([2, 3]);
  });

  test("no headroom near the limit stops a room left nudge", async () => {
    claudeWindowsMeasured(1.2, 1.2, { sevenUsed: 94, lanes: 2 });
    c.history(
      "claude",
      "5h",
      [
        [NOW - 9000, 3],
        [NOW - 1200, 5],
      ],
      Math.trunc(NOW + 4200),
    ); // a recent rate for its status
    const out = await c.claudeOut("--state", c.copyState());
    expect(out).toContain("5h 6%");
    expect(out).not.toContain("room left"); // the 5h window alone would invite work
    expect(out.split("no lane headroom: start nothing new").length - 1).toBe(2);
    const data = await c.json("claude", "--state", c.copyState());
    expect(data.lanes).toEqual({ active: 2, headroom: 0, per_lane_rate: 0.6, window: "7d" });
    const [five, seven] = windows(data) as [Json, Json];
    expect(five.lane_headroom as number).toBeGreaterThan(0);
    expect([seven.lane_headroom, seven.lane_binding, five.status]).toEqual([0, true, "under"]);
    expect(await c.claudeOut("--alerts-only", "--state", c.copyState())).toBe("");
  });

  test("the 5h window binds when it has the least room", async () => {
    claudeWindowsMeasured(10.0, 0.08, { fiveUsed: 60 });
    const data = await c.json("claude");
    expect(windows(data).map((w) => w.lane_headroom)).toEqual([2, 6]);
    expect((data.lanes as Json).window).toBe("5h");
    expect((data.lanes as Json).headroom).toBe(first(data).lane_headroom);
    expect(first(data).lane_binding).toBe(true);
  });

  test("a tie binds the longer window", async () => {
    claudeWindowsMeasured(10.0, 0.08); // both windows end up with room for 6 more lanes
    const data = await c.json("claude");
    const [five, seven] = windows(data) as [Json, Json];
    expect(five.lane_headroom).toBe(seven.lane_headroom);
    expect(five.lane_headroom).toBe(6);
    expect((data.lanes as Json).window).toBe("7d");
  });

  test("no room in both windows binds the longer", async () => {
    (c.claude.five_hour as Fields).utilization = 98;
    (c.claude.seven_day as Fields).utilization = 100;
    const data = await c.json("claude");
    expect(windows(data).map((w) => w.lane_headroom)).toEqual([0, 0]);
    expect([(data.lanes as Json).headroom, (data.lanes as Json).window]).toEqual([0, "7d"]);
  });

  test("the least room binds", async () => {
    claudeWindowsMeasured(1.0, 0.3, { fiveUsed: 6, sevenUsed: 40 });
    const data = await c.json("claude");
    const [five, seven] = windows(data) as [Json, Json];
    const least = Math.min(five.lane_headroom as number, seven.lane_headroom as number);
    expect((data.lanes as Json).headroom).toBe(least);
    expect((data.lanes as Json).window).toBe(
      (five.lane_headroom as number) < (seven.lane_headroom as number) ? "5h" : "7d",
    );
  });

  test("an unmeasured window makes the source unmeasured", async () => {
    claudeWindowsMeasured(1.0, 0.3, { sevenUsed: 10 });
    rmSync(join(c.state, "claude-5h.csv")); // no history for it yet; the week is measured and roomy
    (c.claude.five_hour as Fields).utilization = 94;
    const data = await c.json("claude");
    expect(windows(data)[1]?.lane_headroom).not.toBeNull();
    expect([(data.lanes as Json).headroom, (data.lanes as Json).window]).toEqual([null, "5h"]);
    expect(await c.claudeOut("--state", c.copyState())).toContain("measuring: start at most 1-2 new lanes");
  });

  test("lane counts from before the stretch are not averaged in", async () => {
    const since = codexBurn(20, 0.6, 2);
    // nine lanes counted up to the stretch's first reading: that count covers the ten minutes before it
    c.laneHistory("codex", [...every(300, since - 3600, since + 1, 9), ...every(300, since, NOW, 2)]);
    expect(first(await c.json("codex")).per_lane_rate).toBe(0.3);
  });

  test("lane counts are weighted by the time they cover", async () => {
    const since = codexBurn(20, 0.6, 5); // 0.6%/h over five hours
    // two lanes for four hours counted every 5 minutes, then five for the last hour counted every minute
    c.laneHistory("codex", [...every(300, since, NOW - 3600 + 1, 2), ...every(60, NOW - 3600, NOW, 5)]);
    expect(first(await c.json("codex")).per_lane_rate).toBe(roundTo(0.6 / ((4 * 2 + 5) / 5), 2));
  });

  test("without lane counts over half the stretch the burn is not shared out", async () => {
    const since = codexBurn(20, 0.6, 3);
    // counted every 5 minutes up to 9900s or 9000s before now, plus the ten minutes the count now covers: 48% or 53%
    for (const [counts, shared] of [
      [every(300, since, NOW - 9900 + 1, 3), false],
      [every(300, since, NOW - 9000 + 1, 3), true],
    ] as const) {
      c.laneHistory("codex", [[since - 3000, 3], ...counts]); // the counts stop part way through the stretch
      const w = first(await c.json("codex", "--state", c.copyState()));
      expect([w.active_lanes, w.per_lane_rate !== null]).toEqual([3, shared]);
    }
  });

  test("the lane history is pruned without losing the new sample", async () => {
    c.serve(response());
    c.codexLanes(1);
    c.laneHistory(
      "codex",
      Array.from({ length: 4000 }, (_, i) => [NOW - 100000 + i, 1] as const),
    );
    await c.codex();
    const rows = readFileSync(join(c.state, "lanes-codex.csv"), "utf8")
      .split(/\s+/)
      .filter(Boolean)
      .map((line) => line.split(","));
    expect(rows.length).toBe(2000);
    expect(rows.at(-1)?.slice(0, 2)).toEqual([String(NOW), "1"]);
    expect(existsSync(join(c.state, "lanes-codex.csv.tmp"))).toBe(false);
  });

  test("a lane idle for exactly ten minutes still counts", () => {
    c.codexLanes(1, 600);
    expect(activeLanes("codex", NOW, c.env)).toBe(1);
    c.codexLanes(1, 601);
    expect(activeLanes("codex", NOW, c.env)).toBe(0);
  });

  test("a session line longer than the tail keeps the lane active", () => {
    c.claudeLanes(1);
    const path = join(c.dir, "claude-home/projects/proj/lane0.jsonl");
    appendFileSync(path, `${compact({ type: "user", content: "x".repeat(300000) })}\n`);
    utimesSync(path, NOW - 120, NOW - 120);
    expect(activeLanes("claude", NOW, c.env)).toBe(1);
  });

  test("a line without a timestamp counts by the files mtime", () => {
    c.claudeLanes(1);
    const path = join(c.dir, "claude-home/projects/proj/lane0.jsonl");
    writeFileSync(path, `${compact({ type: "assistant", message: {} })}\n`);
    utimesSync(path, NOW - 120, NOW - 120);
    expect(activeLanes("claude", NOW, c.env)).toBe(1);
  });

  test("a window exactly at its aim has no headroom", async () => {
    c.serve(response({ used: 97, credits: [] }));
    c.codexLanes(1);
    expect(first(await c.json("codex")).lane_headroom).toBe(0);
  });

  test("a pending redeem comes before any lane advice", async () => {
    c.serve(response({ used: 99 }));
    c.history("codex", "7d", [[NOW - 1500, 98.5]]);
    c.laneHistory("codex", [[NOW - 1500, 1]]);
    c.codexLanes(1);
    const out = await c.codex();
    expect(out).toContain("at limit: redeem a banked reset");
    expect(out.split("\n")[0]).not.toContain("lane");
    const w = first(await c.json("codex"));
    expect([w.lane_headroom, w.per_lane_rate]).toEqual([null, null]);
    expect(await c.planLine()).not.toContain("lanes:");
  });

  test("a flat window with lanes is no estimate", async () => {
    c.serve(response({ used: 20 }));
    c.history("codex", "7d", [[NOW - 6 * 3600, 20]]);
    c.laneHistory("codex", every(300, NOW - 6 * 3600, NOW, 2));
    c.codexLanes(2);
    const w = first(await c.json("codex"));
    expect([w.per_lane_rate, w.lane_headroom]).toEqual([null, null]);
  });

  test("whole points over a short stretch are no estimate", async () => {
    const r5 = Math.trunc(NOW + 4200);
    (c.claude.five_hour as Fields).utilization = 2; // 0% -> 2% in ten minutes: anything from 6 to 18%/h
    c.history(
      "claude",
      "5h",
      [
        [NOW - 620, 0],
        [NOW - 300, 1],
      ],
      r5,
    );
    c.laneHistory("claude", [
      [NOW - 620, 4],
      [NOW - 300, 4],
    ]);
    c.claudeLanes(4);
    const data = await c.json("claude", "--state", c.copyState());
    expect([first(data).per_lane_rate, first(data).lane_headroom]).toEqual([null, null]);
    (c.claude.five_hour as Fields).utilization = 3; // three points: enough to measure
    expect(first(await c.json("claude")).per_lane_rate).toBe(roundTo(3 / (620 / 3600) / 4, 2));
  });

  test("a stretch across a drop in use is no estimate", async () => {
    c.serve(response({ used: 2 })); // a reset cleared 80% fifty minutes ago without moving the window's own reset
    c.history("codex", "7d", [
      [NOW - 50 * 3600, 80],
      [NOW - 3000, 0],
    ]);
    c.laneHistory("codex", every(300, NOW - 50 * 3600, NOW, 1));
    c.codexLanes(1);
    expect(first(await c.json("codex")).per_lane_rate).toBeNull();
  });

  test("a stale latest reading is no estimate", async () => {
    codexBurn(20, 0.6, 2);
    c.history("codex", "7d", [
      [NOW - 8 * 3600, 17],
      [NOW - 3 * 3600, 20],
    ]);
    // the app server is gone; the session logs hold a snapshot three hours old
    c.serve(response(), "fail");
    const log = c.sessionLog(20, iso(NOW - 3 * 3600));
    utimesSync(log, NOW - 3 * 3600, NOW - 3 * 3600);
    const stale = codexWindow(20, 604800, RESET, NOW - 3 * 3600, NOW);
    const w = first(await c.json("codex"));
    expect(w.per_lane_rate).toBeNull();
    const rows = [
      [NOW - 8 * 3600, 17, RESET],
      [NOW - 3 * 3600, 20, RESET],
    ] as const;
    expect(recentRate(rows, stale, NOW - 3 * 3600)[0]).not.toBeNull();
  });

  test("a long flat stretch bounds the burn from above", async () => {
    c.serve(response({ used: 20 }));
    c.history("codex", "7d", [[NOW - 50 * 3600, 20]]); // over a fifth of the week without moving a point
    c.laneHistory("codex", every(300, NOW - 50 * 3600, NOW, 1));
    c.codexLanes(1);
    expect(first(await c.json("codex")).per_lane_rate).toBe(roundTo(1 / 50, 2));
  });

  test("a window paced through the others cap aims at 100", async () => {
    claudeWindowsMeasured(1.0, 1.0, { fiveUsed: 6, sevenUsed: 95 }); // the week is in its reserve: no target of its own
    c.history("claude", "7d", [[NOW - 48 * 3600, 95]], Math.trunc(NOW + 4 * 86400)); // flat: at most 1 point in 48h
    c.laneHistory("claude", every(300, NOW - 48 * 3600, NOW, 1));
    const seven = windows(await c.json("claude"))[1] as Json;
    expect(seven.target).toBeNull();
    expect(seven.lane_headroom).toBe(Math.floor((100 - 95) / ((1 / 48) * (seven.hours_left as number)) - 1));
    expect(seven.lane_headroom).toBe(1); // aimed at 97 it would be 0
  });

  test("a window seconds from its reset is no estimate", async () => {
    codexBurn(20, 0.6, 2, { reset: NOW + 60 });
    expect(first(await c.json("codex")).lane_headroom).toBeNull();
  });

  test("an over window carries no lane advice", async () => {
    codexBurn(70, 0.6, 2, { credits: [] });
    const out = await c.codex();
    expect(out).toContain("-> slow down");
    expect(out).not.toContain("lane");
  });

  test("a file vanishing mid scan is skipped", () => {
    c.codexLanes(2);
    c.dangle("codex-home/sessions/2025/10/22/rollout-lane0.jsonl");
    expect(activeLanes("codex", NOW, c.env)).toBe(1);
  });

  test("a waiting window has no lane headroom and says so", async () => {
    c.serve(response({ used: 98, reset: NOW + 3600 }));
    c.codexLanes(1);
    expect(await c.codex()).toContain("-> keep going (no lane headroom: start nothing new)");
    expect(first(await c.json("codex")).lane_headroom).toBe(0);
  });

  test("on pace to run out with no estimate is no headroom", async () => {
    c.serve(response({ used: 68, credits: [] })); // 2.4%/h on average over the week: out in ~13h, nothing banked
    c.codexLanes(1);
    const w = first(await c.json("codex"));
    expect([w.per_lane_rate, w.lane_headroom]).toEqual([null, 0]);
  });

  test("credits with no reported expiry are redeemed not kept", async () => {
    c.serve(response({ used: 98, reset: NOW + 3600, credits: null, count: 2 }));
    expect(await c.codex()).toContain("at limit: redeem a banked reset (2 left, expiry unknown)");
  });

  test("codex history gets at most a row a minute", async () => {
    c.serve(response());
    await c.codex();
    c.clock = NOW + 30;
    await c.codex();
    c.clock = NOW + 90;
    await c.codex();
    const rows = readFileSync(join(c.state, "codex-7d.csv"), "utf8").split(/\s+/).filter(Boolean);
    expect(rows.map((row) => row.split(",")[0])).toEqual([String(NOW), String(NOW + 90)]);
  });

  test("no estimate yet asks for one or two lanes", async () => {
    c.serve(response({ used: 20 }));
    c.codexLanes(1);
    expect(await c.codex()).toContain("(measuring: start at most 1-2 new lanes)");
    const w = first(await c.json("codex"));
    expect([w.active_lanes, w.per_lane_rate, w.lane_headroom]).toEqual([1, null, null]);
  });

  test("a window at its aim has no headroom without an estimate", async () => {
    c.serve(response({ used: 97.5, credits: [] }));
    c.codexLanes(1);
    const w = first(await c.json("codex"));
    expect([w.lane_headroom, w.per_lane_rate]).toEqual([0, null]);
  });

  test("no active lanes is no estimate", async () => {
    codexBurn(20, 0.6, 2);
    const sessions = join(c.dir, "codex-home/sessions/2025/10/22");
    for (const name of readdirSync(sessions)) {
      rmSync(join(sessions, name));
    }
    const w = first(await c.json("codex"));
    expect([w.active_lanes, w.per_lane_rate, w.lane_headroom]).toEqual([0, null, null]);
    expect(await c.codex()).toContain("measuring: start at most 1-2 new lanes");
  });

  test("the window average is not a rate estimate", async () => {
    c.serve(response({ used: 68 })); // 2.4%/h on average, but a single reading
    c.codexLanes(2);
    expect(first(await c.json("codex")).per_lane_rate).toBeNull();
  });

  test("the lanes of the period share the burn", async () => {
    const since = codexBurn(20, 0.6, 3);
    c.laneHistory("codex", [...every(300, since, NOW - 9000 + 1, 1), ...every(300, NOW - 9000, NOW, 3)]); // one lane, then three
    expect(first(await c.json("codex")).per_lane_rate).toBe(roundTo(0.6 / ((1 + 3) / 2), 2));
  });

  test("an unmeasured window far below its aim does not bind", async () => {
    // by its average, 10% after three days ends near 23%; 40% near 93%
    for (const [week, binds] of [
      [10, "5h"],
      [40, "7d"],
    ] as const) {
      claudeWindowsMeasured(10.0, 1.0);
      rmSync(join(c.state, "claude-7d.csv"));
      (c.claude.seven_day as Fields).utilization = week;
      const data = await c.json("claude", "--state", c.copyState());
      expect(windows(data)[1]?.lane_headroom).toBeNull();
      expect((data.lanes as Json).window).toBe(binds);
      expect((data.lanes as Json).headroom).toBe(binds === "5h" ? 6 : null);
    }
  });

  test("active lanes are counted from recent activity", () => {
    c.claudeLanes(1); // active session
    c.claudeLanes(1, { subagents: true }); // active subagent
    mkdirSync(join(c.dir, "claude-home/projects/old"));
    for (const [name, age, spoken] of [
      ["stale-file", 700, 700],
      ["quiet-session", 120, 700],
    ] as const) {
      const path = join(c.dir, "claude-home/projects/old", `${name}.jsonl`);
      writeFileSync(path, `${compact({ type: "assistant", timestamp: iso(NOW - spoken) })}\n`);
      utimesSync(path, NOW - age, NOW - age);
    }
    expect(activeLanes("claude", NOW, c.env)).toBe(2);
    c.codexLanes(2);
    c.codexLanes(1, 700);
    const sessions = join(c.dir, "codex-home/sessions/2025/10/22");
    renameSync(join(sessions, "rollout-lane0.jsonl"), join(sessions, "rollout-lane0.jsonl.bak"));
    expect(activeLanes("codex", NOW, c.env)).toBe(1);
  });

  test("lane counts are remembered once a minute", async () => {
    c.serve(response());
    c.codexLanes(2);
    await c.codex();
    await c.codex();
    expect(readFileSync(join(c.state, "lanes-codex.csv"), "utf8").split(/\s+/).filter(Boolean)).toEqual([
      `${NOW},2,0`,
    ]);
  });

  test("plan gives the lane counts of both providers", async () => {
    codexBurn(20, 0.6, 2);
    c.claudeLanes(1);
    const line = await c.planLine();
    expect(
      line.endsWith(
        " (lanes: Codex room for ~5 more lanes at 0.3%/h each; Claude measuring: start at most 1-2 new lanes)",
      ),
    ).toBe(true);
    const data = await c.json("plan");
    expect(((data.codex as Json).lanes as Json).headroom).toBe(5);
    expect(((data.claude as Json).lanes as Json).headroom).toBeNull();
  });

  test("plan says when the routed provider has no lane headroom", async () => {
    codexBurn(20, 6.0, 5); // five lanes burning 1.2%/h each: no room for more before the reset
    expect(await c.planLine()).toContain(
      " - but Codex has no lane headroom right now (lanes: Codex no lane headroom: start nothing new;",
    );
  });

  test("plan without a route has no lane suffix", async () => {
    expect(await c.planLine()).not.toContain("lanes:");
  });
});

describe("Evidence", () => {
  // How much history a recent rate needs, for the lane estimate and for a short window's status alike.
  const R5 = Math.trunc(NOW + 4200); // the 5h window began 13800s before NOW

  /** The 5h window at `used` now after the readings in `history`, with `lanes` counted at each of them. */
  const fiveHour = async (history: readonly (readonly [number, number])[], used: number, lanes = 3) => {
    (c.claude.five_hour as Fields).utilization = used;
    c.history("claude", "5h", history, R5);
    c.laneHistory(
      "claude",
      history.map(([t]) => [t, lanes] as const),
    );
    c.claudeLanes(lanes);
    return first(await c.json("claude", "--state", c.copyState()));
  };

  /** Readings a minute apart from start up to (not including) until of use rising perHour from offset. */
  const rising = (start: number, until: number, perHour = 6.0, offset = 0.25): [number, number][] => {
    const out: [number, number][] = [];
    for (let t = start; t < until; t += 60) {
      out.push([t, Math.floor(offset + (perHour * (t - start)) / 3600)]);
    }
    return out;
  };

  test("steps a minute apart time two points", async () => {
    // true use 0.25 + 6%/h: it crosses 1% and 2% ten minutes apart, each to within a minute
    const five = await fiveHour(rising(NOW - 1500, NOW), 2);
    expect([five.rate_per_hour, five.rate_basis, five.per_lane_rate]).toEqual([6.0, "recent", 2.0]);
  });

  test("an overdue step is no estimate", async () => {
    // the same two steps, then flat for longer than a point takes at 6%/h: the burn has slowed
    const flat: [number, number][] = [];
    for (let t = NOW - 800; t < NOW; t += 60) {
      flat.push([t, 2.0]);
    }
    const five = await fiveHour([...rising(NOW - 1880, NOW - 800), ...flat], 2);
    expect([five.rate_per_hour, five.per_lane_rate]).toEqual([null, null]);
  });

  test("steps timed too coarsely are no estimate", async () => {
    const five = await fiveHour(
      [
        [NOW - 1500, 0.0],
        [NOW - 900, 1.0],
        [NOW - 600, 1.0],
      ],
      2,
    ); // both steps in 10-minute gaps
    expect([five.rate_per_hour, five.per_lane_rate]).toEqual([null, null]);
  });

  test("a short windows status needs the same evidence", async () => {
    const five = await fiveHour([[NOW - 600, 0.0]], 2); // 0% -> 2% in ten minutes used to read as 12%/h
    expect([five.rate_per_hour, five.projected_at_reset, five.status]).toEqual([null, null, "measuring"]);
    expect(await c.claudeOut("--state", c.copyState())).toContain("5h 2% ? ");
  });

  test("a bounded rate says so", async () => {
    const five = await fiveHour([[NOW - 4000, 5.0]], 5); // no point moved in over an hour of the 5h window
    expect([five.rate_per_hour, five.rate_basis]).toEqual([roundTo(3600 / 4000, 1), "upper-bound"]);
    expect([five.projected_at_reset, five.status]).toEqual([null, "under"]);
    const out = await c.claudeOut("--state", c.copyState());
    expect(out).toContain(
      "5h 5% 0.9%/h (at most) 1.17h left (78.9%/h lands on 97.0%) -> room left: add work",
    );
    expect(out.split(" | ")[0]).not.toContain("ends ~");
  });

  test("a bound never says slow down or on target", async () => {
    // at most 0.9%/h for 1.17h: at 97% and 89% that proves nothing, at 88% it ends under 90, below target less band
    for (const [used, status] of [
      [88, "under"],
      [89, "measuring"],
      [97, "measuring"],
    ] as const) {
      const five = await fiveHour([[NOW - 4000, used]], used);
      expect([five.rate_basis, five.status]).toEqual(["upper-bound", status]);
    }
    expect(await c.claudeOut("--alerts-only", "--state", c.copyState())).toBe(""); // idle at 97%: no "slow down"
  });

  test("nothing before a drop in use counts", async () => {
    // a reset cleared the 5h window without moving it: across the fall the bound would be negative and read as room
    const five = await fiveHour(
      [
        [NOW - 4000, 80.0],
        [NOW - 3000, 0.0],
        [NOW - 60, 1.0],
      ],
      2,
    );
    expect([five.rate_per_hour, five.status]).toEqual([null, "measuring"]);
  });
});

describe("Replay", () => {
  // A morning's Claude readings from 08:11 to 08:37 UTC, shaped like ones agent-pace recorded
  // and replayed through the command. The 5h window had just reset (it resets 13:10 UTC) and
  // lanes were starting; the week stood at 9% with 111h to its reset. Before the evidence bar,
  // the 08:21:52 reading said "no lane headroom": 4% -> 6% in ten minutes read as 11.65%/h,
  // shared by the counts [1, 4] (the 1 taken before the lanes started), 4.66%/h a lane, so
  // floor(91 / (4.66 * 4.80) - 4) = 0. From 08:30:52 on it said "measuring", because the
  // week's whole points had not moved and one unmeasured window made the whole source unmeasured.
  const WEEK_RESET = 1761609600;
  // (time, 5h used, 5h resets_at as reported, lanes active), from claude-5h.csv and lanes-claude.csv
  const READINGS = [
    [1761207094, 4.0, 1761225000, 1], // 08:11:34
    [1761207712, 6.0, 1761225000, 4], // 08:21:52
    [1761208252, 6.0, 1761224999, 3], // 08:30:52
    [1761208320, 6.0, 1761225000, 3], // 08:32:00
    [1761208628, 7.0, 1761225000, 5], // 08:37:08
  ] as const;

  /** Each reading as `claude-pace` printed it and as --json gave it, in order, against one state directory. */
  const replay = async (): Promise<[string, Json][]> => {
    c.claude.seven_day = { utilization: 9.0, resets_at: iso(WEEK_RESET) }; // flat at 9% throughout
    const out: [string, Json][] = [];
    for (const [t, used, reset, active] of READINGS) {
      c.claude.five_hour = { utilization: used, resets_at: iso(reset) };
      c.clock = t;
      // the lanes working at that reading, as session files
      rmSync(join(c.dir, "claude-home/projects"), { recursive: true, force: true });
      c.claudeLanes(active, { at: t });
      out.push([await c.claudeOut(), await c.json("claude")]);
    }
    return out;
  };

  test("the replay writes the recorded history", async () => {
    await replay();
    expect(read(join(c.state, "claude-5h.csv"))).toEqual(READINGS.map(([t, u, r]) => [t, u, r]));
    expect(read(join(c.state, "lanes-claude.csv"))).toEqual(READINGS.map(([t, , , count]) => [t, count, 0]));
  });

  test("two whole points in ten minutes are measuring not no headroom", async () => {
    const [text, data] = (await replay())[1] as [string, Json]; // 08:21:52
    expect(text).not.toContain("no lane headroom");
    expect(text).toContain("measuring: start at most 1-2 new lanes");
    expect(data.lanes).toEqual({ active: 4, headroom: null, per_lane_rate: null, window: "5h" });
  });

  test("three points measure the lanes and the flat week does not bind", async () => {
    const readings = await replay();
    for (const [, data] of readings.slice(0, 4)) {
      expect([(data.lanes as Json).headroom, (data.lanes as Json).window]).toEqual([null, "5h"]);
    }
    const [text, data] = readings[4] as [string, Json]; // 08:37:08: 4% -> 7% over 25.6 minutes, 3.80 lanes on average over it
    const rate = 3 / ((1761208628 - 1761207094) / 3600);
    const lanes = (600 * 4 + 540 * 3 + 68 * 3 + 308 * 5) / (1761208628 - 1761207094 - 18); // 18s before 08:11:52 no count covers
    const [five, week] = windows(data) as [Json, Json];
    expect(five.per_lane_rate).toBe(roundTo(rate / lanes, 2));
    expect(five.lane_headroom).toBe(
      Math.floor((97 - 7) / ((rate / lanes) * (five.hours_left as number)) - 5),
    );
    expect(data.lanes).toEqual({ active: 5, headroom: 5, per_lane_rate: 1.85, window: "5h" });
    expect([week.used, week.lane_headroom, week.lane_binding]).toEqual([9, null, false]);
    expect(text).toContain("room for ~5 more lanes at 1.85%/h each");
  });
});

describe("Plan", () => {
  const behind = (used = 20) => {
    c.serve(response({ used }));
    c.history("codex", "7d", [
      [NOW - 7200, used - 6],
      [NOW - 60, used],
    ]);
  };

  test("expiring codex credit that is behind routes work to codex", async () => {
    behind();
    expect(await c.plan()).toBe("route spare work to Codex: banked reset expires in 36h and needs 2.4%/h");
  });

  test("an on track credit is not a reason", async () => {
    expect(await c.plan()).toBe(
      "no routing preference: no banked reset is at risk and neither provider is nearly used",
    );
  });

  test("credits after the reset that are behind route work to codex", async () => {
    c.serve(response({ used: 5, credits: CREDITS.slice(1) }));
    expect(await c.plan()).toBe(
      "route spare work to Codex: 2 banked resets to use, needs 0.7%/h to reach 100% by the reset",
    );
  });

  test("tight claude routes work to codex", async () => {
    (c.claude.seven_day as Fields).utilization = 93;
    expect(await c.plan()).toBe("Claude 7d at 93%: route work to Codex");
  });

  test("tight codex without credits routes work to claude", async () => {
    c.serve(response({ used: 93, credits: [] }));
    expect(await c.plan()).toBe("Codex 7d at 93%: route work to Claude");
  });

  test("a session grant does not route work to a full week", async () => {
    c.grant({ type: "session", clears: ["five_hour"], ends_at: "2025-10-22T14:00:00+00:00" });
    (c.claude.seven_day as Fields).utilization = 96;
    expect(await c.plan()).toBe("Claude 7d at 96%: route work to Codex");
  });

  test("the headline says what it could not read", async () => {
    c.remove("bin/codex");
    expect(await c.plan()).toBe("no routing preference from Claude alone: Codex could not be read");
  });

  test("both reasons are given", async () => {
    (c.claude.seven_day as Fields).utilization = 93;
    behind();
    expect(await c.plan()).toBe(
      "route spare work to Codex: banked reset expires in 36h and needs 2.4%/h; Claude 7d at 93%",
    );
  });

  test("a banked claude reset at risk routes work to claude", async () => {
    c.grant({ ends_at: "2025-10-23T16:00:00+00:00" });
    (c.claude.seven_day as Fields).utilization = 60;
    c.history(
      "claude",
      "7d",
      [
        [NOW - 7200, 54],
        [NOW - 120, 60],
      ],
      Math.trunc(NOW + 4 * 86400),
    );
    expect(await c.plan()).toBe(
      "route spare work to Claude: banked 7d reset expires in 29h and needs 1.5%/h",
    );
  });

  test("the sooner expiry goes first and the other is mentioned", async () => {
    c.grant({ ends_at: "2025-10-25T16:00:00+00:00" });
    (c.claude.seven_day as Fields).utilization = 30;
    c.history(
      "claude",
      "7d",
      [
        [NOW - 7200, 24],
        [NOW - 120, 30],
      ],
      Math.trunc(NOW + 4 * 86400),
    );
    behind();
    const line = await c.plan();
    expect(line).toStartWith(
      "route spare work to Codex: banked reset expires in 36h and needs 2.4%/h; Claude also: banked 7d reset expires in 77h",
    );
  });

  test("unreachable expiry asks to fill then redeem", async () => {
    const credits = [{ ...CREDITS[0], expiresAt: NOW + 10 * 3600 }, ...CREDITS.slice(1)];
    c.serve(response({ used: 20, credits }));
    expect(await c.plan()).toStartWith(
      "route spare work to Codex: banked reset expires in 10h and cannot be filled by then",
    );
  });

  test("codex at the limit says redeem but does not", async () => {
    c.serve(response({ used: 98 }));
    expect(await c.plan()).toBe(
      "Codex is at its limit: redeem a banked reset (3 left, next expires Fri 24 Oct 00:10), then route spare work to Codex",
    );
    expect(c.methods()).toEqual(["initialize", "initialized", "account/rateLimits/read"]);
  });

  test("claude at the limit says limit reset", async () => {
    c.grant({ ends_at: "2025-10-23T16:00:00+00:00" });
    (c.claude.seven_day as Fields).utilization = 98;
    expect(await c.plan()).toBe(
      "Claude is at its limit: run /limit-reset in Claude Code (1 left, next expires Thu 23 Oct 17:00), then route spare work to Claude",
    );
  });

  test("both tight without credits has nowhere to route", async () => {
    (c.claude.seven_day as Fields).utilization = 93;
    c.serve(response({ used: 95, credits: [] }));
    expect(await c.plan()).toBe("Claude 7d at 93% and Codex 7d at 95%: neither has room, wait for a reset");
  });

  test("unreadable claude still plans for codex", async () => {
    c.claudeError = new TypeError("offline");
    behind();
    const [out] = await c.runPace("plan");
    expect(out).toStartWith("route spare work to Codex: banked reset expires");
    expect(out).toContain("claude: unavailable");
  });

  test("unreadable codex with tight claude says so", async () => {
    c.remove("bin/codex");
    (c.claude.seven_day as Fields).utilization = 93;
    expect(await c.plan()).toContain("Codex could not be read");
  });

  test("json recommendation", async () => {
    behind();
    const data = await c.json("plan");
    expect(data.route).toBe("codex");
    expect(data.redeem).toBe(false);
    expect(((data.codex as Json).banked_resets as Json).count).toBe(3);
    expect(((data.claude as Json).banked_resets as Json).count).toBe(0);
  });

  test("a full short window of the routed provider is mentioned", async () => {
    const resp = response({ used: 20 });
    const snap = resp.result.rateLimits as Fields;
    snap.secondary = snap.primary;
    snap.primary = { usedPercent: 98, windowDurationMins: 300, resetsAt: NOW + 3600 };
    resp.result.rateLimitsByLimitId = { codex: snap };
    c.serve(resp);
    c.history("codex", "7d", [
      [NOW - 7200, 14],
      [NOW - 60, 20],
    ]);
    const line = await c.plan();
    expect(line).toStartWith("route spare work to Codex: banked 7d reset expires in 36h and needs 2.4%/h");
    expect(line.split(" - but ")[0]).toEndWith("; but Codex 5h at 98%");
    expect(line).toContain(" - but Codex has no lane headroom right now"); // the full 5h window leaves it none
  });

  test("plan takes no watch alerts or notify", async () => {
    for (const flag of [["--watch"], ["--alerts-only"], ["--notify", "true"]]) {
      const [, err] = await c.runPace("plan", ...flag);
      expect(err).toContain("do not apply");
    }
  });
});
