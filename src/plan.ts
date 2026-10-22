import { assess, laneSummary, type PaceOptions, tooLateToFill, type WindowAssessment } from "./assess.ts";
import { ExitError, RateLimited, survivableErrorText } from "./errors.ts";
import type { Host } from "./host.ts";
import { formatFixed } from "./python-format.ts";
import { dumps, type JsonObject } from "./python-json.ts";
import { readSource } from "./readings.ts";
import { lanePhrase, noteLines, perHour, redeemIt, render, sourceJson, Wording } from "./report.ts";
import { type ReadingWithLanes, SOURCES, type Source } from "./usage.ts";

export const NAMES: Record<Source, string> = { claude: "Claude", codex: "Codex" };

type Readings = Partial<Record<Source, WindowAssessment[]>>;
type Errors = Partial<Record<Source, string>>;

/**
 * The most-used window at or past 100 - reserve with no reset to spend on it; null if there is
 * none. A window at its limit that resets on its own soon (the reset stays banked) counts as full.
 */
function tight(res: readonly WindowAssessment[], reserve: number): WindowAssessment | null {
  let hottest: WindowAssessment | null = null;
  for (const a of res) {
    if (a.used >= 100 - reserve && !(a.banked && a.banked.action !== "wait")) {
      if (hottest === null || a.used > hottest.used) {
        hottest = a;
      }
    }
  }
  return hottest;
}

type Reason = readonly [number, Source, string];

/** Python's sort of (soon, source, text) tuples. */
function byReason(a: Reason, b: Reason): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  if (a[1] !== b[1]) {
    return a[1] < b[1] ? -1 : 1;
  }
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
}

/**
 * One recommendation from the readings: [route, redeem, text]. route is codex, claude or none.
 *
 * Banked resets come first (redeem one at the limit, or fill a window before its reset
 * expires), then a provider that is nearly used. It only advises: nothing is redeemed.
 */
export function recommend(
  readings: Readings,
  errors: Errors,
  reserve: number,
  words: Wording,
): [Source | "none", boolean, string] {
  const redeems: Reason[] = [];
  let pulls: Reason[] = [];
  const hot: Partial<Record<Source, WindowAssessment | null>> = {};
  const read = SOURCES.filter((s) => readings[s] !== undefined);
  for (const source of read) {
    const res = readings[source] ?? [];
    const name = NAMES[source];
    hot[source] = tight(res, reserve);
    for (const a of res) {
      const b = a.banked;
      if (!b) {
        continue;
      }
      const soon = b.expiresInH === null ? Infinity : b.expiresInH;
      const which = res.length > 1 ? `${a.window} ` : "";
      const expiresIn = formatFixed(b.expiresInH ?? 0, 0);
      const needs = perHour(b.rateNeeded);
      if (b.action === "wait") {
        continue; // at its limit, resetting on its own soon: nothing to fill
      }
      if (b.action === "redeem") {
        redeems.push([
          soon,
          source,
          `${name} is at its limit: ${redeemIt(source, "a banked reset")} (${b.count} left, ${words.nextExpiry(b)}), ` +
            `then route spare work to ${name}`,
        ]);
      } else if (tooLateToFill(b)) {
        redeems.push([
          soon,
          source,
          `${redeemIt(source)} now: a ${name} banked ${which}reset expires in ${expiresIn}h and ` +
            `the window cannot be filled in time; then route spare work to ${name}`,
        ]);
      } else if (b.action === "redeem-anyway") {
        const peak = perHour(b.peakRate);
        pulls.push([
          soon,
          source,
          `banked ${which}reset expires in ${expiresIn}h and cannot be filled by then ` +
            `(needs ${needs}, peak ${peak}); fill what you can, then ${redeemIt(source)}`,
        ]);
      } else if (a.status !== "on-target" && b.mode === "expiry") {
        pulls.push([soon, source, `banked ${which}reset expires in ${expiresIn}h and needs ${needs}`]);
      } else if (a.status !== "on-target") {
        pulls.push([
          soon,
          source,
          `${b.count} banked ${which}reset${b.count > 1 ? "s" : ""} to use, ` +
            `needs ${needs} to reach 100% by the reset`,
        ]);
      }
    }
  }
  if (redeems.length > 0) {
    redeems.sort(byReason);
    return [(redeems[0] as Reason)[1], true, redeems.map((r) => r[2]).join("; ")];
  }
  // a reset that lifts only a short window does not help while the longest window is full
  pulls = pulls.filter(([, src]) => {
    const h = hot[src];
    return !(h && h === readings[src]?.at(-1));
  });
  const notes = (src: Source) => {
    const h = hot[src] as WindowAssessment;
    return `${h.window} at ${formatFixed(h.used, 0)}%`;
  };
  const hotSources = SOURCES.filter((s) => hot[s] !== undefined);
  if (pulls.length > 0) {
    pulls.sort(byReason);
    const [first, why] = [(pulls[0] as Reason)[1], (pulls[0] as Reason)[2]];
    let text = `route spare work to ${NAMES[first]}: ${why}`;
    text += pulls
      .slice(1)
      .filter(([, src]) => src !== first)
      .map(([, src, reason]) => `; ${NAMES[src]} also: ${reason}`)
      .join("");
    text += hotSources
      .filter((src) => hot[src] && src !== first)
      .map((src) => `; ${NAMES[src]} ${notes(src)}`)
      .join("");
    if (hot[first]) {
      text += `; but ${NAMES[first]} ${notes(first)}`; // a window of the provider it routes to is full
    }
    return [first, false, text];
  }
  const cold = read.filter((src) => !hot[src]);
  for (const src of hotSources) {
    if (!hot[src]) {
      continue;
    }
    const other: Source = src === "claude" ? "codex" : "claude";
    if (cold.includes(other)) {
      return [other, false, `${NAMES[src]} ${notes(src)}: route work to ${NAMES[other]}`];
    }
    if (hot[other]) {
      return [
        "none",
        false,
        `${NAMES.claude} ${notes("claude")} and ${NAMES.codex} ${notes("codex")}: neither has room, wait for a reset`,
      ];
    }
    return [
      "none",
      false,
      `${NAMES[src]} ${notes(src)}, and ${NAMES[other]} could not be read (${errors[other] ?? "None"})`,
    ];
  }
  const failed = SOURCES.filter((s) => errors[s] !== undefined);
  if (failed.length > 0) {
    return [
      "none",
      false,
      `no routing preference from ${read.map((s) => NAMES[s]).join(", ")} alone: ` +
        `${failed.map((s) => NAMES[s]).join(", ")} could not be read`,
    ];
  }
  return [
    "none",
    false,
    "no routing preference: no banked reset is at risk and neither provider is nearly used",
  ];
}

/** Why a source could not be read, as `plan` reports it; anything else ends the command. */
function readError(error: unknown): string {
  if (error instanceof ExitError) {
    return error.message.replace(/^agent-pace: /, "");
  }
  if (error instanceof RateLimited) {
    return error.message;
  }
  const text = survivableErrorText(error);
  if (text === null) {
    throw error;
  }
  return text;
}

export async function runPlan(options: PaceOptions & { readonly json: boolean }, host: Host): Promise<void> {
  const read: { source: Source; reading: ReadingWithLanes; res: WindowAssessment[] }[] = [];
  const errors: Errors = {};
  for (const source of SOURCES) {
    try {
      const reading = await readSource(source, options.state, host);
      const res = assess(source, reading.windows, options, reading.banked, reading.lanes, host.now());
      read.push({ source, reading, res });
    } catch (error) {
      errors[source] = readError(error);
    }
  }
  const failed = SOURCES.filter((s) => errors[s] !== undefined);
  if (read.length === 0) {
    const why = failed.map((k) => `${k}: ${errors[k]}`).join("; ");
    throw new ExitError(`agent-pace: neither source could be read: ${why}`);
  }
  const readings: Readings = Object.fromEntries(read.map(({ source, res }) => [source, res]));
  const words = new Wording(host.timeZone);
  let [route, redeem, text] = recommend(readings, errors, options.reserve, words);
  const routed = read.find((r) => r.source === route);
  if (routed && !redeem) {
    // work is going somewhere: say how many lanes each provider can take
    if (laneSummary(routed.res)[0] === 0) {
      text += ` - but ${NAMES[routed.source]} has no lane headroom right now`;
    }
    const order = [routed, ...read.filter((r) => r !== routed)];
    text += ` (lanes: ${order.map((r) => `${NAMES[r.source]} ${lanePhrase(r.res)}`).join("; ")})`;
  }
  if (options.json) {
    const out: Record<string, JsonObject | string | boolean> = {
      recommendation: text,
      route,
      redeem,
      errors: Object.fromEntries(failed.map((s) => [s, errors[s] ?? ""])),
    };
    for (const { source, reading, res } of read) {
      out[source] = sourceJson(reading, res);
    }
    host.stdout(`${dumps(out)}\n`);
    return;
  }
  const lines = [text];
  for (const { source, reading, res } of read) {
    lines.push(`  ${render(source, res, host.now(), host.timeZone)}`);
    for (const line of noteLines(source, res, reading, words)) {
      lines.push(`    ${line}`);
    }
  }
  for (const source of failed) {
    lines.push(`  ${source}: unavailable (${errors[source]})`);
  }
  host.stdout(lines.map((line) => `${line}\n`).join(""));
}
