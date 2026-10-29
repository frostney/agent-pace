// The command around the readings: exit statuses, the usage endpoint's error answers, help,
// --watch and --notify. The Python suite did not cover these; each expectation here is what
// the Python version printed for the same inputs.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Case, type Fields, iso, NOW } from "./harness.ts";

setDefaultTimeout(30_000);

let c: Case;

beforeEach(() => {
  c = new Case();
});

afterEach(() => {
  c.cleanup();
});

/** Python's clock prefix is the wall clock; compare the rest. */
const withoutClock = (text: string) => text.replace(/^(\s*)\d\d:\d\d (claude|codex)/gm, "$1HH:MM $2");

const answer = (status: number, statusText: string, headers: Record<string, string> = {}) => {
  c.claudeResponse = () => new Response("", { status, statusText, headers });
};

describe("UsageEndpointErrors", () => {
  test("a rate limit backs off ten minutes and exits 3", async () => {
    answer(429, "Too Many Requests");
    const [out, err] = await c.runPace("claude");
    expect([out, err, c.status]).toEqual([
      "",
      "agent-pace: the usage endpoint is rate limiting; next try in 10 min\n",
      3,
    ]);
  });

  test("a longer retry-after is the wait", async () => {
    answer(429, "Too Many Requests", { "retry-after": "1200" });
    expect((await c.runPace("claude"))[1]).toBe(
      "agent-pace: the usage endpoint is rate limiting; next try in 20 min\n",
    );
  });

  test("a rejected token exits 1 with what to do", async () => {
    answer(401, "Unauthorized");
    const [, err] = await c.runPace("claude");
    expect([err, c.status]).toEqual([
      "agent-pace: Claude token rejected (expired?); run `claude` once to refresh it\n",
      1,
    ]);
  });

  test("a server error is reported and the reading ends normally", async () => {
    answer(500, "Internal Server Error");
    const [out, err] = await c.runPace("claude");
    expect([out, err, c.status]).toEqual(["", "agent-pace: HTTP Error 500: Internal Server Error\n", 0]);
  });

  test("plan reports the server error and reads the other source", async () => {
    answer(500, "Internal Server Error");
    const [out] = await c.runPace("plan");
    expect(withoutClock(out)).toBe(
      "no routing preference from Codex alone: Claude could not be read\n" +
        "  HH:MM codex: 7d 68% 2.4%/h (window avg) 139.81h left, runs out in ~13.3h (0.9%/h lands on 100%) -> keep going (measuring: start at most 1-2 new lanes)\n" +
        "    banked reset expires Fri 24 Oct 00:10 (in 35.8h): fill to 100% by then (needs 0.9%/h, now 2.4%/h), then redeem it [3 banked]\n" +
        "  claude: unavailable (HTTP Error 500: Internal Server Error)\n",
    );
  });
});

describe("Help", () => {
  // as Python 3.15's argparse printed it at 80 columns
  test("agent-pace help", async () => {
    const [out] = await c.runPace("--help");
    expect([out, c.status]).toEqual([
      readFileSync(join(import.meta.dir, "fixtures/help-agent-pace.txt"), "utf8"),
      0,
    ]);
  });

  test("claude-pace takes no source", async () => {
    expect((await c.runAs("claude-pace", "--help"))[0]).toBe(
      readFileSync(join(import.meta.dir, "fixtures/help-claude-pace.txt"), "utf8"),
    );
    const [, err] = await c.runAs("claude-pace", "codex");
    expect([err.split("\n").at(-2), c.status]).toEqual([
      "claude-pace: error: unrecognized arguments: codex",
      2,
    ]);
  });
});

describe("Watch", () => {
  /** A 5h window at 90% that rolls over between readings two minutes apart. */
  const rolling = () => {
    const r1 = Math.trunc(NOW + 4200);
    c.claude.five_hour = { utilization: 90, resets_at: iso(r1) };
    c.history(
      "claude",
      "5h",
      [
        [NOW - 7200, 80],
        [NOW - 3600, 85],
      ],
      r1 - 18000,
    );
    c.sleeps = 3;
    c.between = () => {
      c.clock += 120;
      const n = c.slept.length;
      c.claude.five_hour = { utilization: 3 + n, resets_at: iso(r1 + 18000 * n) } satisfies Fields;
    };
  };

  test("a reset is announced while watching, not at the start", async () => {
    rolling();
    const [out] = await c.runPace("claude", "--watch");
    expect(withoutClock(out).split("\n")).toEqual([
      "HH:MM claude: 5h 90% ? 1.17h left (6.0%/h lands on 97.0%) -> measuring: start at most 1-2 new lanes | 7d 40% 0.6%/h (window avg) 96.0h left, ends ~93% (0.6%/h lands on 97.0%) -> keep going",
      "claude 5h window reset: the last one ended at 90% (10% unused)",
      "HH:MM claude: 5h 4% ? 6.13h left (15.2%/h lands on 97.0%) -> measuring: start at most 1-2 new lanes | 7d 40% 0.6%/h (window avg) 95.97h left, ends ~93% (0.6%/h lands on 97.0%) -> keep going",
      "claude 5h window reset: the last one ended at 4% (96% unused)",
      "HH:MM claude: 5h 5% ? 11.1h left (8.3%/h lands on 97.0%) -> measuring: start at most 1-2 new lanes | 7d 40% 0.6%/h (window avg) 95.93h left, ends ~93% (0.6%/h lands on 97.0%) -> keep going",
      "",
    ]);
    expect(c.slept).toEqual([300, 300, 300]);
  });

  test("notify gets each reset with the reading, after its own words", async () => {
    rolling();
    const notes = join(c.dir, "notes");
    const script = join(c.dir, "bin", "notify");
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${notes}\n`);
    chmodSync(script, 0o755);
    const [out] = await c.runPace("claude", "--watch", "--alerts-only", "--notify", `${script} 'two words'`);
    expect(out).toBe(
      "claude 5h window reset: the last one ended at 90% (10% unused)\n" +
        "claude 5h window reset: the last one ended at 4% (96% unused)\n",
    );
    expect(
      readFileSync(notes, "utf8")
        .replace(/ \d\d:\d\d claude:/g, " claude:")
        .split("\n"),
    ).toEqual([
      "two words claude 5h window reset: the last one ended at 90% (10% unused) claude: 5h 4% ? 6.13h left (15.2%/h lands on 97.0%) -> measuring: start at most 1-2 new lanes | 7d 40% 0.6%/h (window avg) 95.97h left, ends ~93% (0.6%/h lands on 97.0%) -> keep going",
      "two words claude 5h window reset: the last one ended at 4% (96% unused) claude: 5h 5% ? 11.1h left (8.3%/h lands on 97.0%) -> measuring: start at most 1-2 new lanes | 7d 40% 0.6%/h (window avg) 95.93h left, ends ~93% (0.6%/h lands on 97.0%) -> keep going",
      "",
    ]);
  });
});

describe("PacingConstants", () => {
  // The Python suite let FAR_BELOW move without a failure. A week at 25% with three days gone
  // and four left ends near 92% at twice its average burn, so it does not hold the source at
  // "measuring"; at three times it would.
  test("an unmeasured week binds only past twice its average burn", async () => {
    const r5 = Math.trunc(NOW + 4200);
    (c.claude.five_hour as Fields).utilization = 6;
    (c.claude.seven_day as Fields).utilization = 25;
    const since = NOW - 0.3 * 3600;
    c.history("claude", "5h", [[since, 3]], r5);
    c.laneHistory(
      "claude",
      Array.from({ length: 3 }, (_, i) => [since + (i + 1) * 300, 1] as const),
    );
    c.claudeLanes(1);
    const data = await c.json("claude");
    expect(data.lanes).toEqual({ active: 1, headroom: 7, per_lane_rate: 10, window: "5h", hours: 1 });
  });
});
