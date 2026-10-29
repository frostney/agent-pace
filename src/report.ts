import {
  type BankAdvice,
  laneSummary,
  type RateBasis,
  redeeming,
  type Status,
  tooLateToFill,
  type WindowAssessment,
} from "./assess.ts";
import { RESET_JITTER_S } from "./history.ts";
import { floatRepr, formatFixed, numberText, roundToInt } from "./python-format.ts";
import { float, type Json, type JsonObject } from "./python-json.ts";
import { isoOrNull, localClock, localStamp, parseIso } from "./time-format.ts";
import type { Reading, ReadingWithLanes, Source } from "./usage.ts";

/** What the lane headroom says, as advice. */
export function lanePhrase(res: readonly WindowAssessment[]): string {
  const [more, per, , hours] = laneSummary(res);
  if (more === null) {
    return "measuring: start at most 1-2 new lanes";
  }
  if (more === 0) {
    return "no lane headroom: start nothing new";
  }
  const each = `at ${per === null ? "None" : floatRepr(per)}%/h each`;
  return `room for ~${more} more lane${more > 1 ? "s" : ""} ${each}${hours === null ? "" : ` for ${floatRepr(hours)}h`}`;
}

const ADVICE: Record<Status, string> = {
  over: "slow down",
  under: "room left: add work",
  "on-target": "keep going",
  measuring: "measuring",
  info: "",
};

const BASIS_NOTE: Record<RateBasis, string> = {
  recent: "",
  "upper-bound": " (at most)",
  lanes: " (lanes)",
  "window-average": " (window avg)",
};

export function render(
  source: Source,
  res: readonly WindowAssessment[],
  now: number,
  timeZone: string | undefined,
): string {
  const parts = res.map((a) => {
    let note = BASIS_NOTE[a.rateBasis ?? "recent"];
    if (a.rateBasis === "lanes" && a.windowAverageRate !== null) {
      note = ` (lanes, window avg ${floatRepr(a.windowAverageRate)}%/h)`;
    }
    const rate = a.ratePerHour === null ? "?" : `${floatRepr(a.ratePerHour)}%/h${note}`;
    let s = `${a.window} ${formatFixed(a.used, 0)}% ${rate} ${floatRepr(a.hoursLeft)}h left`;
    if (a.projectedAtReset !== null && a.projectedAtReset <= 100) {
      s += `, ends ~${a.projectedAtReset}%`;
    } else if (a.projectedAtReset !== null && a.ratePerHour) {
      const h = (100 - a.used) / a.ratePerHour;
      s += h < 48 ? `, runs out in ~${formatFixed(h, 1)}h` : `, runs out in ~${formatFixed(h / 24, 1)}d`;
    }
    if (a.target !== null && a.rateNeededForTarget !== null) {
      s += ` (${floatRepr(a.rateNeededForTarget)}%/h lands on ${numberText(a.target)}%)`;
    }
    if (a.evenPacePerDay !== null) {
      s += `, even pace ${floatRepr(a.evenPacePerDay)}%/day`;
    }
    if (a.note) {
      s += ` [${a.note}]`;
    }
    let advice = ADVICE[a.status];
    const more = laneSummary(res)[0];
    const phrase = lanePhrase(res);
    if (redeeming(a.banked)) {
      // the line below says to redeem; lanes come after
    } else if (a.status === "under" && more === 0) {
      advice = phrase; // room left, but not for another lane
    } else if (a.laneBinding && a.status !== "over") {
      if (a.status === "measuring") {
        advice = more === null ? phrase : `measuring (${phrase})`;
      } else {
        advice = advice ? `${advice} (${phrase})` : phrase;
      }
    }
    if (advice) {
      s += ` -> ${advice}`;
    }
    return s;
  });
  let stale = "";
  const first = res[0];
  if (source === "codex" && first) {
    const age = (now - parseIso(first.observedAt)) / 60;
    stale = age >= 10 ? ` (snapshot ${formatFixed(age, 0)} min old)` : "";
  }
  return `${localClock(now, timeZone)} ${source}${stale}: ${parts.join(" | ")}`;
}

export function perHour(x: number | null): string {
  return x === null ? "?" : `${floatRepr(x)}%/h`;
}

/** Text in the report and the recommendation: dates are local, as on the reader's clock. */
export class Wording {
  constructor(private readonly timeZone: string | undefined) {}

  local(iso: string | null): string {
    return iso === null ? "None" : localStamp(parseIso(iso), this.timeZone);
  }

  /** When the next banked reset expires, as text. */
  nextExpiry(b: BankAdvice): string {
    if (b.expiresAt !== null) {
      return `next expires ${this.local(b.expiresAt)}`;
    }
    return b.expiryUnlisted ? "expiry unknown" : "none expire";
  }
}

export function redeemIt(source: Source, what = "it"): string {
  return source === "claude" ? "run /limit-reset in Claude Code" : `redeem ${what}`;
}

/** One line per window with banked resets: what to do with them. agent-pace never redeems one. */
export function bankedLines(source: Source, res: readonly WindowAssessment[], words: Wording): string[] {
  const lines: string[] = [];
  for (const a of res) {
    const b = a.banked;
    if (!b) {
      continue;
    }
    const n = b.count > 1 ? ` [${b.count} banked]` : "";
    const which = res.length > 1 ? ` ${a.window}` : "";
    if (b.action === "wait") {
      lines.push(
        `at limit, but the ${a.window} window resets on its own in ${formatFixed(a.hoursLeft, 1)}h: keep the banked reset ` +
          `(${b.count} left, ${words.nextExpiry(b)})`,
      );
    } else if (b.action === "redeem") {
      const windowNote = which ? `, ${a.window} window` : "";
      lines.push(
        `at limit: ${redeemIt(source, "a banked reset")} (${b.count} left${windowNote}, ${words.nextExpiry(b)})`,
      );
    } else if (b.mode === "expiry") {
      const head = `banked${which} reset expires ${words.local(b.expiresAt)} (in ${formatFixed(b.expiresInH ?? 0, 1)}h)`;
      if (tooLateToFill(b)) {
        lines.push(
          `${head}: too close to reach 100% (at ${formatFixed(a.used, 0)}%); ${redeemIt(source)} now, an unused reset is lost${n}`,
        );
      } else if (b.action === "redeem-anyway") {
        lines.push(
          `${head}: cannot reach 100% by then (needs ${perHour(b.rateNeeded)}, peak seen ${perHour(b.peakRate)}); ` +
            `${redeemIt(source)} anyway by ${words.local(b.deadline)}, an unused reset is lost${n}`,
        );
      } else {
        lines.push(
          `${head}: fill to 100% by then (needs ${perHour(b.rateNeeded)}, now ${perHour(b.rateNow)}), then ${redeemIt(source)}${n}`,
        );
      }
    } else {
      lines.push(
        `${b.count} banked${which} reset${b.count > 1 ? "s" : ""}, none expiring before the ${a.window} window resets ` +
          `(${words.nextExpiry(b)}): fill to 100% by the reset (needs ${perHour(b.rateNeeded)}, now ${perHour(b.rateNow)}), ` +
          `then ${redeemIt(source, "one")}`,
      );
    }
  }
  return lines;
}

/** The banked resets as --json reports them. */
export function bankedJson(reading: Reading): JsonObject {
  const banked = reading.banked;
  const credits =
    banked?.credits == null
      ? null
      : banked.credits.map((c) => ({ expires_at: isoOrNull(c.expiresAt), title: c.title, clears: c.clears }));
  return {
    known: banked !== null,
    count: banked === null ? null : banked.count,
    credits,
    via: reading.via,
    note: reading.note,
  };
}

export function lanesJson(res: readonly WindowAssessment[]): JsonObject {
  const [more, per, window, hours] = laneSummary(res);
  return {
    active: res[0]?.activeLanes ?? 0,
    headroom: more,
    per_lane_rate: float(per),
    window,
    hours: float(hours),
  };
}

function bankJson(b: BankAdvice | null): Json {
  if (b === null) {
    return null;
  }
  return {
    mode: b.mode,
    action: b.action,
    count: b.count,
    expires_at: b.expiresAt,
    expires_in_h: float(b.expiresInH),
    deadline: b.deadline,
    hours_to_deadline: float(b.hoursToDeadline),
    rate_needed: float(b.rateNeeded),
    rate_now: float(b.rateNow),
    peak_rate: float(b.peakRate),
    credits_without_expiry: b.creditsWithoutExpiry,
    expiry_unlisted: b.expiryUnlisted,
    redeem_margin_h: float(b.redeemMarginH),
    projected_at_deadline: b.projectedAtDeadline,
  };
}

/** A window as --json reports it, with the types Python gave each field. */
export function windowJson(a: WindowAssessment): JsonObject {
  return {
    window: a.window,
    used: float(a.used),
    resets_at: a.resetsAt,
    hours_left: float(a.hoursLeft),
    rate_per_hour: float(a.ratePerHour),
    rate_basis: a.rateBasis,
    window_average_rate: float(a.windowAverageRate),
    projected_at_reset: a.projectedAtReset,
    target: a.target,
    rate_needed_for_target: float(a.rateNeededForTarget),
    status: a.status,
    note: a.note,
    even_pace_per_day: float(a.evenPacePerDay),
    previous_window_ended_at: float(a.previousWindowEndedAt),
    banked: bankJson(a.banked),
    active_lanes: a.activeLanes,
    per_lane_rate: float(a.perLaneRate),
    lane_headroom: a.laneHeadroom,
    lane_binding: a.laneBinding,
    observed_at: a.observedAt,
    lane_basis: a.laneBasis,
    lane_rates: a.laneRates === null ? null : a.laneRates.map(float),
    lane_hours: float(a.laneHours),
    token_cost:
      a.tokenCost === null
        ? null
        : {
            points_per_dollar: float(a.tokenCost.pointsPerDollar),
            runs: a.tokenCost.runs,
            points: float(a.tokenCost.points),
            dollars: float(a.tokenCost.dollars),
          },
  };
}

/** One source's reading as --json reports it. */
export function sourceJson(reading: ReadingWithLanes, res: readonly WindowAssessment[]): JsonObject {
  return { windows: res.map(windowJson), banked_resets: bankedJson(reading), lanes: lanesJson(res) };
}

/** The lines under a source's reading: what to do with its banked resets, then its note. */
export function noteLines(
  source: Source,
  res: readonly WindowAssessment[],
  reading: Reading,
  words: Wording,
): string[] {
  return [...bankedLines(source, res, words), ...(reading.note ? [reading.note] : [])];
}

/** One message per window that rolled over since the last reading, each said once. */
export function rollovers(source: Source, res: readonly WindowAssessment[], seen: Set<string>): string[] {
  const messages: string[] = [];
  for (const a of res) {
    // reset times drift by fractions of a second, sometimes across a minute boundary
    const key = [source, a.window, roundToInt(parseIso(a.resetsAt) / RESET_JITTER_S)].join("\u0000");
    if (a.previousWindowEndedAt !== null && !seen.has(key)) {
      seen.add(key);
      const ended = a.previousWindowEndedAt;
      messages.push(
        `${source} ${a.window} window reset: the last one ended at ${formatFixed(ended, 0)}% (${formatFixed(100 - ended, 0)}% unused)`,
      );
    }
  }
  return messages;
}
