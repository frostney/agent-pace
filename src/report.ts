import {
  type BankAdvice,
  type CreditPlan,
  creditsOf,
  hoursToEmpty,
  laneSummary,
  laneSupply,
  type RateBasis,
  redeeming,
  type Status,
  tooLateToFill,
  type WindowAssessment,
} from "./assess.ts";
import { RESET_JITTER_S } from "./history.ts";
import { capacity, enabled, inPool, poolName } from "./hub.ts";
import { floatRepr, formatFixed, numberText, roundTo, roundToInt } from "./python-format.ts";
import { float, type Json, type JsonObject } from "./python-json.ts";
import { isoOrNull, isoUtc, localClock, localStamp, parseIso } from "./time-format.ts";
import type { Banked, HubAccount, HubPool, Reading, ReadingWithLanes, Source } from "./usage.ts";

/** An amount of usage credits with its unit, such as "429.39 GBP". */
export function creditAmount(x: number, credits: CreditPlan): string {
  return `${formatFixed(x, credits.places)} ${credits.unit}`;
}

/** The pool the lanes draw on once a window is at its limit, such as "on usage credits (429.39 GBP left)". */
export function creditPool(credits: CreditPlan): string {
  return credits.left === null
    ? "on usage credits (no spend limit)"
    : `on usage credits (${creditAmount(credits.left, credits)} left)`;
}

/** What the lane headroom says, as advice; drawing on usage credits, which pool it is. */
export function lanePhrase(res: readonly WindowAssessment[]): string {
  const [more, per, , hours, pool] = laneSupply(res);
  const credits = creditsOf(res);
  const paid = pool === "usage-credits" ? credits : null;
  const lead = paid ? `${creditPool(paid)}: ` : "";
  if (more === null) {
    return `${lead}measuring: start at most 1-2 new lanes`;
  }
  if (more === 0) {
    return `${lead}no lane headroom: start nothing new`;
  }
  const rate = per === null ? "None" : paid ? `${creditAmount(per, paid)}/h` : `${floatRepr(per)}%/h`;
  return `${lead}room for ~${more} more lane${more > 1 ? "s" : ""} at ${rate} each${hours === null ? "" : ` for ${floatRepr(hours)}h`}`;
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
  name: string = source,
): string {
  const parts = res.map((a) => {
    let note = BASIS_NOTE[a.rateBasis ?? "recent"];
    if (a.rateBasis === "lanes" && a.windowAverageRate !== null) {
      note = ` (lanes, window avg ${floatRepr(a.windowAverageRate)}%/h)`;
    }
    const rate = a.ratePerHour === null ? "?" : `${floatRepr(a.ratePerHour)}%/h${note}`;
    let s = `${a.window} ${formatFixed(a.used, 0)}% ${rate} ${floatRepr(a.hoursLeft)}h left`;
    // a pool's accounts that reset first hand back what they used, but it can run dry before they do
    const dry = a.returns ? hoursToEmpty(a.used, a.ratePerHour, a.returns) : null;
    if (a.projectedAtReset !== null && a.projectedAtReset <= 100 && !(dry !== null && dry < a.hoursLeft)) {
      s += `, ends ~${a.projectedAtReset}%`;
    } else if (a.projectedAtReset !== null && a.ratePerHour) {
      const h = dry ?? (100 - a.used) / a.ratePerHour;
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
    } else if (a.laneBinding && a.credits?.drawing) {
      advice = phrase; // the plan is full: the lanes draw on the usage credits now
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
  return `${localClock(now, timeZone)} ${name}${stale}: ${parts.join(" | ")}`;
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

  /** A unix time on the reader's clock. */
  at(t: number): string {
    return localStamp(t, this.timeZone);
  }

  /** When the next banked reset expires, as text. */
  nextExpiry(b: BankAdvice): string {
    if (b.expiresAt !== null) {
      return `next expires ${this.local(b.expiresAt)}`;
    }
    return b.expiryUnlisted ? "expiry unknown" : "none expire";
  }
}

/** How to redeem a banked reset; a hub pool's are redeemed on the hub, which holds the logins. */
export function redeemIt(source: Source, what = "it", pooled = false): string {
  if (pooled) {
    return `redeem ${what} on the hub`;
  }
  return source === "claude" ? "run /limit-reset in Claude Code" : `redeem ${what}`;
}

/** One line per window with banked resets: what to do with them. agent-pace never redeems one. */
export function bankedLines(
  source: Source,
  res: readonly WindowAssessment[],
  words: Wording,
  pooled = false,
): string[] {
  const redeem = (what = "it") => redeemIt(source, what, pooled);
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
        `at limit: ${redeem("a banked reset")} (${b.count} left${windowNote}, ${words.nextExpiry(b)})`,
      );
    } else if (b.mode === "expiry") {
      const head = `banked${which} reset expires ${words.local(b.expiresAt)} (in ${formatFixed(b.expiresInH ?? 0, 1)}h)`;
      if (tooLateToFill(b)) {
        lines.push(
          `${head}: too close to reach 100% (at ${formatFixed(a.used, 0)}%); ${redeem()} now, an unused reset is lost${n}`,
        );
      } else if (b.action === "redeem-anyway") {
        lines.push(
          `${head}: cannot reach 100% by then (needs ${perHour(b.rateNeeded)}, peak seen ${perHour(b.peakRate)}); ` +
            `${redeem()} anyway by ${words.local(b.deadline)}, an unused reset is lost${n}`,
        );
      } else {
        lines.push(
          `${head}: fill to 100% by then (needs ${perHour(b.rateNeeded)}, now ${perHour(b.rateNow)}), then ${redeem()}${n}`,
        );
      }
    } else {
      lines.push(
        `${b.count} banked${which} reset${b.count > 1 ? "s" : ""}, none expiring before the ${a.window} window resets ` +
          `(${words.nextExpiry(b)}): fill to 100% by the reset (needs ${perHour(b.rateNeeded)}, now ${perHour(b.rateNow)}), ` +
          `then ${redeem("one")}`,
      );
    }
  }
  return lines;
}

/** The banked resets as --json reports them. */
export function bankedJson(reading: Reading): JsonObject {
  return { ...bankJsonOf(reading.banked), via: reading.via, note: reading.note };
}

function bankJsonOf(banked: Banked | null): JsonObject {
  const credits =
    banked?.credits == null
      ? null
      : banked.credits.map((c) => ({ expires_at: isoOrNull(c.expiresAt), title: c.title, clears: c.clears }));
  return {
    known: banked !== null,
    count: banked === null ? null : banked.count,
    credits,
  };
}

export function lanesJson(res: readonly WindowAssessment[]): JsonObject {
  const [more, per, window, hours, pool] = laneSupply(res);
  return {
    active: res[0]?.activeLanes ?? 0,
    headroom: more,
    per_lane_rate: float(per),
    window,
    hours: float(hours),
    pool,
  };
}

/** The usage credits as --json reports them; null without credits to draw on. */
export function creditsJson(res: readonly WindowAssessment[]): Json {
  const c = creditsOf(res);
  if (c === null) {
    return null;
  }
  return {
    unit: c.unit,
    left: float(c.left),
    drawing: c.drawing,
    hours_left: float(c.hoursLeft),
    rate_per_hour: float(c.ratePerHour),
    per_lane_rate: float(c.perLaneRate),
    lane_headroom: c.laneHeadroom,
    lane_hours: float(c.laneHours),
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

/** One source's reading as --json reports it; a hub client's adds the accounts it pools. */
export function sourceJson(
  reading: ReadingWithLanes,
  res: readonly WindowAssessment[],
  now: number,
): JsonObject {
  return {
    windows: res.map(windowJson),
    banked_resets: bankedJson(reading),
    lanes: lanesJson(res),
    usage_credits: creditsJson(res),
    ...(reading.pool ? { hub: hubJson(reading.pool, now) } : {}),
  };
}

/** The hub's accounts as --json reports them, with what the pool takes from each. */
export function hubJson(pool: HubPool, now: number): JsonObject {
  const members = pool.accounts.filter(inPool);
  return {
    url: pool.url,
    observed_at: isoUtc(pool.observedAt),
    accounts_in_pool: members.length,
    accounts_enabled: enabled(pool).length,
    pool_capacity: members.reduce((sum, a) => sum + capacity(a), 0),
    accounts: pool.accounts.map((a) => ({
      label: a.label,
      plan: a.plan,
      weight: a.weight,
      capacity: capacity(a),
      in_pool: inPool(a),
      state: a.state,
      detail: a.detail,
      read_at: isoOrNull(a.readAt),
      cooling_down: a.coolingDown,
      windows: a.windows.map((w) => ({
        window: w.name,
        used: float(w.used),
        resets_at: isoUtc(w.resetsAt),
        hours_left: float(roundTo(Math.max(0, (w.resetsAt - now) / 3600), 2)),
      })),
      banked_resets: bankJsonOf(a.banked),
    })),
  };
}

/** What one account's banked resets say, such as "2 banked, next expires Sat 15 Nov 10:00". */
function accountBanked(banked: Banked | null, words: Wording): string | null {
  if (banked === null || banked.count === 0) {
    return null;
  }
  const expiries = (banked.credits ?? []).flatMap((c) => (c.expiresAt === null ? [] : [c.expiresAt]));
  const next = expiries.length > 0 ? `next expires ${words.at(Math.min(...expiries))}` : "expiry unknown";
  return `${banked.count} banked, ${next}`;
}

/** One line for one account on the hub: its windows, resets and banked resets, or why it is left out. */
function accountLine(a: HubAccount, now: number, words: Wording): string {
  const about = [a.plan, a.weight === null ? null : `weight ${a.weight}`].filter((x) => x !== null);
  const head = `${a.label}${about.length > 0 ? ` (${about.join(", ")})` : ""}`;
  if (a.state === "disabled") {
    return `${head}: disabled on the hub, not in the pool`;
  }
  if (a.state === "unreadable") {
    return `${head}: unreadable${a.detail ? ` (${a.detail})` : ""}, left out of the pool`;
  }
  const windows = a.windows.map((w) => {
    const left = Math.max(0, (w.resetsAt - now) / 3600);
    return `${w.name} ${formatFixed(w.used, 0)}% resets ${words.at(w.resetsAt)} (in ${formatFixed(left, 1)}h)`;
  });
  const notes = [
    // the last good reading stands in while a read fails (a 429 is left alone as long as it asks)
    a.detail && a.readAt !== null ? `as read ${words.at(a.readAt)} (now ${a.detail})` : null,
    accountBanked(a.banked, words),
    a.coolingDown ? "cooling down on the hub" : null,
    capacity(a) > 0 ? null : "weight 0, left out of the pool",
  ].filter((x) => x !== null);
  const body = windows.length > 0 ? windows.join(" | ") : "no window running";
  return `${head}: ${body}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`;
}

/** The lines under a pooled reading: one per account on the hub. */
export function accountLines(pool: HubPool, now: number, words: Wording): string[] {
  return pool.accounts.map((a) => accountLine(a, now, words));
}

/** What a reading's line is called: the source, or its pool on a hub client. */
export function readingName(source: Source, reading: ReadingWithLanes): string {
  return reading.pool ? poolName(source, reading.pool) : source;
}

/** The lines under a source's reading: what to do with its banked resets, then its note. */
export function noteLines(
  source: Source,
  res: readonly WindowAssessment[],
  reading: ReadingWithLanes,
  words: Wording,
): string[] {
  return [
    ...bankedLines(source, res, words, reading.pool !== undefined),
    ...(reading.note ? [reading.note] : []),
  ];
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
