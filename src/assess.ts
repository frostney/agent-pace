import { EVIDENCE_ERROR, EVIDENCE_POINTS, USE_STEP } from "./evidence.ts";
import { type HistoryRow, logPath, RESET_JITTER_S, read } from "./history.ts";
import { LANE_IDLE_S } from "./lanes.ts";
import { Float, formatFixed, roundTo, roundToInt } from "./python-format.ts";
import { isoOrNull, isoUtc } from "./time-format.ts";
import { fitTokenCost, laneRates, type TokenCost } from "./token-burn.ts";
import type { TokenUse } from "./token-ledger.ts";
import type { Banked, Credit, LaneReading, Source, UsageWindow } from "./usage.ts";

export type PlanMode = "fill" | "even";

/** The number a target is, whether Python held it as an int or a float. */
const targetValue = (target: number | Float) => (target instanceof Float ? target.value : target);

export interface PaceOptions {
  readonly target: number;
  readonly band: number;
  readonly plan: PlanMode;
  readonly reserve: number;
  readonly redeemMargin: number;
  readonly state: string;
}

export type Status = "over" | "under" | "on-target" | "measuring" | "info";
export type BankAction = "fill" | "wait" | "redeem" | "redeem-anyway";

/** How to use the banked resets on one window. */
export interface BankAdvice {
  readonly mode: "expiry" | "reset";
  readonly action: BankAction;
  readonly count: number;
  readonly expiresAt: string | null;
  readonly expiresInH: number | null;
  readonly deadline: string | null;
  readonly hoursToDeadline: number;
  readonly rateNeeded: number | null;
  readonly rateNow: number | null;
  readonly peakRate: number | null;
  readonly creditsWithoutExpiry: number;
  readonly expiryUnlisted: number;
  readonly redeemMarginH: number;
  readonly projectedAtDeadline: number | null;
}

export interface LanePlan {
  activeLanes: number;
  perLaneRate: number | null;
  laneHeadroom: number | null;
  /** How the per-lane burn was found: each lane's own tokens, or the window's burn shared out. */
  laneBasis: "tokens" | "shared" | null;
  /** With the tokens basis, each spending lane's burn (%/h), highest first. */
  laneRates: number[] | null;
}

/** One window's assessment; --json reports it field for field. */
export interface WindowAssessment extends LanePlan {
  readonly window: string;
  readonly used: number;
  readonly resetsAt: string;
  readonly hoursLeft: number;
  readonly ratePerHour: number | null;
  readonly rateBasis: RateBasis | null;
  readonly projectedAtReset: number | null;
  /** --target is a float, a capped or banked target an int: Python printed them differently. */
  readonly target: number | Float | null;
  readonly rateNeededForTarget: number | null;
  readonly status: Status;
  readonly note: string | null;
  readonly evenPacePerDay: number | null;
  readonly previousWindowEndedAt: number | null;
  readonly banked: BankAdvice | null;
  laneBinding: boolean;
  readonly observedAt: string;
  /** Points of this window a dollar of local spending has been worth; null while unlearned. */
  readonly tokenCost: TokenCost | null;
}

const sameWindow = (rows: readonly HistoryRow[], w: UsageWindow) =>
  rows.filter((r) => Math.abs(r[2] - w.resetsAt) < RESET_JITTER_S);

/** The first element with the largest key, as Python's max(items, key=...). */
function maxBy<T>(items: readonly T[], key: (item: T) => number): T | undefined {
  let best: T | undefined;
  for (const item of items) {
    if (best === undefined || key(item) > key(best)) {
      best = item;
    }
  }
  return best;
}

function rateOf(rows: readonly HistoryRow[], w: UsageWindow, now: number): [number | null, RateBasis | null] {
  const start = w.resetsAt - w.lengthS;
  if (w.lengthS >= 86400) {
    // a week is bursty: pace it by its average so far, not the last minutes
    return now - start > 3600 ? [w.used / ((now - start) / 3600), "window-average"] : [null, null];
  }
  const [rate, , , basis] = recentRate(rows, w, now); // held to the same evidence as the lane estimate
  // no window-average fallback for short windows: right after a reset it is only the start-up burst
  return [rate, basis];
}

/** The final reading of the previous window, if this window began after it. */
function lastRollover(rows: readonly HistoryRow[], w: UsageWindow): HistoryRow | null {
  return rows.filter((r) => r[2] < w.resetsAt - RESET_JITTER_S).at(-1) ?? null;
}

/** Long-window points per short-window point, from paired readings within the same short window. */
function costRatio(shortRows: readonly HistoryRow[], longRows: readonly HistoryRow[]): number | null {
  if (shortRows.length < 2 || longRows.length < 2) {
    return null;
  }
  const nearest = (t: number) => {
    let best = longRows[0] as HistoryRow;
    for (const r of longRows) {
      if (Math.abs(r[0] - t) < Math.abs(best[0] - t)) {
        best = r;
      }
    }
    return best;
  };
  let ds = 0;
  let dl = 0;
  for (let i = 0; i + 1 < shortRows.length; i++) {
    const a = shortRows[i] as HistoryRow;
    const b = shortRows[i + 1] as HistoryRow;
    if (Math.abs(a[2] - b[2]) >= RESET_JITTER_S || b[1] < a[1]) {
      continue;
    }
    const la = nearest(a[0]);
    const lb = nearest(b[0]);
    if (Math.abs(la[0] - a[0]) < 600 && Math.abs(lb[0] - b[0]) < 600 && lb[1] >= la[1]) {
      ds += b[1] - a[1];
      dl += lb[1] - la[1];
    }
  }
  return ds >= 5 ? dl / ds : null;
}

/** The fastest burn seen in this window (%/h): over spans of an hour or more, and its average so far. */
function peakRate(
  rows: readonly HistoryRow[],
  w: UsageWindow,
  now: number,
  rate: number | null,
): number | null {
  const start = w.resetsAt - w.lengthS;
  const seen = rate === null ? [] : [rate];
  if (now - start > 3600) {
    seen.push(w.used / ((now - start) / 3600));
  }
  const same = sameWindow(rows, w);
  same.forEach((a, i) => {
    const b = same.slice(i + 1).find((r) => r[0] - a[0] >= 3600);
    if (b !== undefined) {
      seen.push((b[1] - a[1]) / ((b[0] - a[0]) / 3600));
    }
  });
  return seen.length > 0 ? Math.max(...seen) : null;
}

/** Of the window's length: a stretch this long bounds the burn even if use barely moved. */
const EVIDENCE_SPAN = 0.2;
/** The share of the stretch the lane counts must cover to share the burn out. */
const LANE_COVERAGE = 0.5;
/** An unmeasured window that ends at or below its aim even at this multiple of its average burn does not bind. */
const FAR_BELOW = 2;

/** How a rate was measured: over a recent stretch, as an upper bound on it, or as the window's average. */
export type RateBasis = "recent" | "upper-bound" | "window-average";

export type RecentRate = readonly [
  rate: number | null,
  since: number | null,
  until: number | null,
  basis: "recent" | "upper-bound" | null,
];

/**
 * The recent burn (%/h) of a window, the stretch (since, until) it was measured on, and its
 * basis ("recent", or "upper-bound"); not the window average.
 *
 * A short stretch says little when usage comes in whole points (0% -> 2% in ten minutes is
 * anything from 6 to 18%/h). The steps up time it first (stepRate). Otherwise the stretch ends
 * at the latest reading and reaches back until use moved EVIDENCE_POINTS points: the rate is
 * then the move over the span. If it reaches back EVIDENCE_SPAN of the window first, the move
 * plus one point over the span bounds the burn from above. Anything shorter is no estimate, as
 * is a latest reading over LANE_IDLE_S old (a stale Codex snapshot). Nothing before a drop in
 * use counts (a reset cleared it without moving the window).
 */
export function recentRate(rows: readonly HistoryRow[], w: UsageWindow, now: number): RecentRate {
  let same = sameWindow(rows, w);
  const latest = same.at(-1);
  if (latest === undefined || now - latest[0] > LANE_IDLE_S) {
    return [null, null, null, null];
  }
  let drop = 0;
  for (let i = same.length - 1; i > 0; i--) {
    if ((same[i] as HistoryRow)[1] < (same[i - 1] as HistoryRow)[1]) {
      drop = i;
      break;
    }
  }
  same = same.slice(drop);
  const stepped = stepRate(same);
  if (stepped) {
    return [...stepped, "recent"];
  }
  const end = same.at(-1) as HistoryRow;
  for (const start of same.slice(0, -1).reverse()) {
    const span = end[0] - start[0];
    const moved = end[1] - start[1];
    if (span < 540) {
      continue;
    }
    if (moved >= EVIDENCE_POINTS) {
      return [moved / (span / 3600), start[0], end[0], "recent"];
    }
    if (span >= w.lengthS * EVIDENCE_SPAN) {
      return [(moved + USE_STEP) / (span / 3600), start[0], end[0], "upper-bound"];
    }
  }
  return [null, null, null, null];
}

/**
 * The burn between two moments use stepped up, [rate, since, until], or null if no pair is
 * precise enough.
 *
 * A step up between two readings crossed a whole point somewhere in the gap between them, so
 * two steps timed at their gaps' midpoints give the points between them to within half of each
 * gap in time, however few points that is: readings a minute apart time a single point in ten
 * minutes to within a tenth. The pair is the latest step and the nearest earlier one whose
 * timing keeps the rate within EVIDENCE_ERROR. The latest step must not be overdue: with no
 * step since for longer than a point takes at that rate, the burn has slowed.
 */
function stepRate(same: readonly HistoryRow[]): [number, number, number] | null {
  const steps: [level: number, at: number, gap: number][] = [];
  for (let i = 0; i + 1 < same.length; i++) {
    const a = same[i] as HistoryRow;
    const b = same[i + 1] as HistoryRow;
    if (b[1] > a[1]) {
      steps.push([b[1], (a[0] + b[0]) / 2, b[0] - a[0]]);
    }
  }
  const last = steps.at(-1);
  if (last === undefined) {
    return null;
  }
  const [level, at, gap] = last;
  for (const [level0, at0, gap0] of steps.slice(0, -1).reverse()) {
    const span = at - at0;
    if (span >= 540 && (gap0 + gap) / 2 <= EVIDENCE_ERROR * span) {
      const rate = (level - level0) / (span / 3600);
      const overdue = (((same.at(-1) as HistoryRow)[0] - (at + gap / 2)) * rate) / 3600 >= USE_STEP;
      return overdue ? null : [rate, at0, at];
    }
  }
  return null;
}

/**
 * The lanes active over (since, until], each count weighted by the time it covers; null if too
 * little is covered.
 *
 * A count covers the LANE_IDLE_S before it (a lane counts if it worked then), back to the
 * count before it, so a count taken before the lanes started says nothing about the stretch
 * after it. Time no count covers is left out; with under LANE_COVERAGE of the stretch covered
 * the lanes are not known.
 */
function laneMean(lanes: LaneReading, since: number, until: number): number | null {
  let covered = 0;
  let weighted = 0;
  let previous = since;
  const counts = [...lanes.rows, [lanes.at, lanes.active] as const].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  for (const [t, count] of counts) {
    const lo = Math.max(previous, t - LANE_IDLE_S);
    const hi = Math.min(t, until);
    if (hi > lo) {
      covered += hi - lo;
      weighted += count * (hi - lo);
    }
    previous = Math.max(previous, t);
  }
  if (covered <= 0 || covered < LANE_COVERAGE * (until - since)) {
    return null;
  }
  return weighted / covered;
}

/**
 * How many more lanes the headroom to aim supports, from the burn each active lane has been
 * causing.
 *
 * per-lane rate = recent window rate / lanes active over that stretch (time-weighted);
 * supported lanes = headroom points / (per-lane rate * hours), less those already running.
 * Null while there is nothing to estimate from.
 */
function lanePlan(
  w: UsageWindow,
  aim: number,
  horizonH: number,
  recent: RecentRate,
  lanes: LaneReading | null,
  measured: readonly number[] | null,
): LanePlan {
  const active = lanes ? lanes.active : 0;
  const out: LanePlan = {
    activeLanes: active,
    perLaneRate: null,
    laneHeadroom: null,
    laneBasis: null,
    laneRates: null,
  };
  if (aim - w.used <= 0) {
    out.laneHeadroom = 0; // already at the aim: nothing to add, estimate or not
    return out;
  }
  if (measured && measured.length > 0) {
    // each lane at its own burn; a new lane is taken to burn as the running ones do on average
    const total = measured.reduce((sum, r) => sum + r, 0);
    const mean = total / measured.length;
    out.laneBasis = "tokens";
    out.laneRates = measured.map((r) => roundTo(r, 2));
    if (horizonH <= 0.05 || !(mean > 0)) {
      return out;
    }
    out.perLaneRate = roundTo(mean, 2);
    out.laneHeadroom = Math.max(0, Math.floor(((aim - w.used) / horizonH - total) / mean));
    return out;
  }
  const [rate, since, until] = recent;
  if (
    !active ||
    rate === null ||
    rate <= 0 ||
    horizonH <= 0.05 ||
    since === null ||
    until === null ||
    !lanes
  ) {
    return out;
  }
  const mean = laneMean(lanes, since, until);
  if (!mean) {
    return out; // the lanes over that stretch are not known: the burn cannot be shared out
  }
  const per = rate / mean;
  out.laneBasis = "shared";
  out.perLaneRate = roundTo(per, 2);
  out.laneHeadroom = Math.max(0, Math.floor((aim - w.used) / (per * horizonH) - active));
  return out;
}

/** Whether the window ends at or below aim even at FAR_BELOW times its average burn so far (after its first hour). */
function farBelow(w: UsageWindow, aim: number, horizonH: number, now: number): boolean {
  const elapsedH = (now - (w.resetsAt - w.lengthS)) / 3600;
  return elapsedH > 1 && w.used + ((FAR_BELOW * w.used) / elapsedH) * horizonH <= aim;
}

interface WindowBank {
  readonly count: number;
  readonly credits: readonly Credit[];
  readonly unlisted: number;
}

/**
 * The banked resets to spend on window w: those whose longest cleared window is w. Null if
 * there are none. A reset that is already expired does not count. A reset with no list entry
 * (only the count is known) is taken to clear the longest window.
 */
function bankedFor(
  banked: Banked | null,
  windows: readonly UsageWindow[],
  w: UsageWindow,
  now: number,
): WindowBank | null {
  if (!banked || banked.count <= 0) {
    return null;
  }
  const longest = maxBy(windows, (x) => x.lengthS);
  const listed = banked.credits;
  const mine: Credit[] = [];
  for (const c of listed ?? []) {
    if (c.expiresAt !== null && c.expiresAt <= now) {
      continue;
    }
    const hit = windows.filter((x) => c.clears === null || c.clears.includes(x.name));
    if (hit.length > 0 && maxBy(hit, (x) => x.lengthS) === w) {
      mine.push(c);
    }
  }
  const unlisted =
    w === longest ? (listed === null ? banked.count : Math.max(0, banked.count - listed.length)) : 0;
  return mine.length > 0 || unlisted ? { count: mine.length + unlisted, credits: mine, unlisted } : null;
}

/**
 * How to use the banked resets on window w: fill it to 100% and redeem. Null with no resets
 * banked. A reset that expires before the window does sets the deadline (its expiry less
 * --redeem-margin); otherwise the window's own reset does. Running out early is fine, so there
 * is no slow down here.
 */
function bankPlan(
  w: UsageWindow,
  rate: number | null,
  peak: number | null,
  banked: WindowBank | null,
  options: PaceOptions,
  now: number,
): BankAdvice | null {
  if (!banked) {
    return null;
  }
  const used = w.used;
  const leftH = Math.max(0, (w.resetsAt - now) / 3600);
  const known = banked.credits
    .map((c) => c.expiresAt)
    .filter((e): e is number => e !== null)
    .sort((a, b) => a - b);
  const unlisted = banked.unlisted; // expiry not reported
  const risky = known.find((e) => e < w.resetsAt) ?? null;
  let deadline: number | null;
  let horizon: number;
  if (risky !== null) {
    deadline = Math.max(now, risky - options.redeemMargin * 3600);
    horizon = (deadline - now) / 3600;
  } else {
    deadline = null;
    horizon = leftH;
  }
  const needed = horizon > 0.05 ? (100 - used) / horizon : null;
  let action: BankAction = "fill";
  if (used >= Math.max(options.target, 100 - options.band)) {
    // at the limit, however low --target is set; with nothing about to expire, a window that
    // resets on its own soon would waste the reset (a reset whose expiry is not reported might
    // expire first: that one is redeemed)
    action = risky === null && !unlisted && leftH <= options.redeemMargin ? "wait" : "redeem";
  } else if (risky !== null) {
    // the peak rate is at least the current one, so out of reach at the peak is out of reach now too
    if (horizon <= 0.05 || (peak !== null && used + peak * horizon < 100)) {
      action = "redeem-anyway";
    }
  }
  const next = known[0] ?? null;
  return {
    mode: risky !== null ? "expiry" : "reset",
    action,
    count: banked.count,
    expiresAt: isoOrNull(next),
    expiresInH: next === null ? null : roundTo((next - now) / 3600, 2),
    deadline: isoOrNull(deadline),
    hoursToDeadline: roundTo(horizon, 2),
    rateNeeded: needed === null ? null : roundTo(needed, 1),
    rateNow: rate === null ? null : roundTo(rate, 1),
    peakRate: peak === null ? null : roundTo(peak, 1),
    creditsWithoutExpiry: banked.credits.filter((c) => c.expiresAt === null).length,
    expiryUnlisted: unlisted,
    redeemMarginH: options.redeemMargin,
    projectedAtDeadline: rate === null ? null : roundToInt(used + rate * horizon),
  };
}

/** Whether a banked reset expires too soon to fill its window first: redeem it now. */
export function tooLateToFill(bank: BankAdvice): boolean {
  return bank.action === "redeem-anyway" && bank.hoursToDeadline <= 0.05;
}

/** Whether the advice for this banked window is to redeem now. */
export function redeeming(bank: BankAdvice | null): boolean {
  return !!bank && (bank.action === "redeem" || tooLateToFill(bank));
}

/**
 * The window whose lane headroom the source reports (out is ordered short to long).
 *
 * No room at all in one window settles it (the longer on a tie); otherwise a window that
 * cannot be measured yet makes the whole source unmeasured, since it may be the one that
 * binds, unless it is roomy (far below its aim by its average burn); otherwise the least room.
 * With every window unmeasured the source is unmeasured.
 */
function bindingLane(out: readonly WindowAssessment[], roomy: ReadonlySet<string>): WindowAssessment {
  const notRedeeming = out.filter((a) => !redeeming(a.banked));
  const live = notRedeeming.length > 0 ? notRedeeming : out;
  const known = live.filter((a) => a.laneHeadroom !== null);
  const full = known.filter((a) => a.laneHeadroom === 0);
  const lastFull = full.at(-1);
  if (lastFull) {
    return lastFull;
  }
  const unmeasured = live.filter((a) => a.laneHeadroom === null);
  const blocking = unmeasured.filter((a) => !roomy.has(a.window));
  if (blocking.length > 0 || known.length === 0) {
    return (blocking[0] ?? unmeasured[0]) as WindowAssessment;
  }
  let best = known[0] as WindowAssessment;
  for (const a of known) {
    const headroom = a.laneHeadroom ?? 0;
    const bestHeadroom = best.laneHeadroom ?? 0;
    if (headroom < bestHeadroom || (headroom === bestHeadroom && live.indexOf(a) > live.indexOf(best))) {
      best = a;
    }
  }
  return best;
}

export function assess(
  source: Source,
  windows: readonly UsageWindow[],
  options: PaceOptions,
  banked: Banked | null,
  lanes: LaneReading | null,
  now: number,
  tokens: TokenUse | null = null,
): WindowAssessment[] {
  const out: WindowAssessment[] = [];
  const roomy = new Set<string>();
  const rows = new Map(windows.map((w) => [w.name, read(logPath(options.state, source, w.name))]));
  const rowsOf = (w: UsageWindow) => rows.get(w.name) ?? [];
  const short = windows[0] as UsageWindow;
  const long = windows.length > 1 ? (windows.at(-1) as UsageWindow) : null;
  let plan = options.plan;
  const banks = new Map(windows.map((w) => [w.name, bankedFor(banked, windows, w, now)]));
  if (
    plan === "fill" &&
    long !== null &&
    options.reserve > 0 &&
    long.used >= 100 - options.reserve &&
    !banks.get(long.name)
  ) {
    plan = "even"; // the long window is down to its reserve: stop filling short windows, make the rest last
  }
  for (const w of windows) {
    const r = rowsOf(w);
    const [rate, basis] = rateOf(r, w, now);
    const estimate = basis === "upper-bound" ? null : rate; // a bound can show room left, never on target or over
    const leftH = Math.max(0, (w.resetsAt - now) / 3600);
    let target: number | Float | null = new Float(options.target);
    let note: string | null = null;
    if (plan === "even" && long !== null && w === short) {
      const k = costRatio(r, rowsOf(long));
      if (k) {
        const windowsLeft = Math.max(1, (long.resetsAt - now) / short.lengthS);
        const afford = (100 - long.used) / windowsLeft / k; // short-window points this window may use
        const cap = short.used + afford * Math.min(1, leftH / (short.lengthS / 3600));
        if (cap < options.target) {
          target = roundToInt(cap);
          note = `capped by ${long.name} (1 ${short.name} point = ${formatFixed(k, 2)} ${long.name} points)`;
        }
      }
    }
    if (plan === "even" && long !== null && w === long) {
      target = null; // the long window is paced through the short window's cap
    }
    const projected = estimate === null ? null : w.used + estimate * leftH;
    let goal = target === null ? null : targetValue(target);
    let needed = goal !== null && leftH > 0.05 ? (goal - w.used) / leftH : null;
    const bank = bankPlan(
      w,
      estimate,
      peakRate(r, w, now, estimate),
      banks.get(w.name) ?? null,
      options,
      now,
    );
    let ahead: number | null = null;
    if (bank) {
      // the longest window is filled to 100% and then redeemed
      target = 100;
      note = null;
      goal = 100;
      needed = bank.rateNeeded;
      ahead = bank.projectedAtDeadline;
    }
    let status: Status;
    let even = 0;
    if (goal === null) {
      even = (100 - w.used) / Math.max(leftH / 24, 0.01);
      status = "info";
    } else if (bank) {
      if (bank.action === "redeem") {
        status = "on-target";
      } else if (bank.action === "redeem-anyway") {
        status = "under";
      } else if (ahead === null) {
        status = "measuring";
      } else {
        status = ahead < 100 - options.band ? "under" : "on-target";
      }
    } else if (projected === null) {
      const bounded = basis === "upper-bound" && rate !== null;
      status = bounded && w.used + rate * leftH < goal - options.band ? "under" : "measuring";
    } else if (projected > Math.min(100, goal + 3)) {
      status = "over";
    } else if (projected < goal - options.band) {
      status = "under";
    } else {
      status = "on-target";
    }
    const previous = lastRollover(r, w);
    // the aim is the target (100% with a reset banked); a window paced through another's cap makes the rest last to 100%
    const aim = goal === null ? 100 : goal;
    const horizon = bank?.deadline ? bank.hoursToDeadline : leftH;
    const tokenCost = tokens ? fitTokenCost(r, tokens, now) : null;
    const measured = tokens && tokenCost ? laneRates(tokens, tokenCost, now) : null;
    const lane = lanePlan(w, aim, horizon, recentRate(r, w, now), lanes, measured);
    if (redeeming(bank)) {
      // redeem first: the lanes the window takes afterwards are another question
      lane.perLaneRate = null;
      lane.laneHeadroom = null;
      lane.laneBasis = null;
      lane.laneRates = null;
    } else if (bank && bank.action === "wait") {
      lane.laneHeadroom = 0; // full until it resets on its own
    } else if (lane.laneHeadroom === null && !bank && projected !== null && projected > 100) {
      lane.laneHeadroom = 0; // no per-lane estimate yet, but already on pace to run out
    }
    out.push({
      window: w.name,
      used: w.used,
      resetsAt: isoUtc(w.resetsAt),
      hoursLeft: roundTo(leftH, 2),
      ratePerHour: rate === null ? null : roundTo(rate, 1),
      rateBasis: basis,
      projectedAtReset: projected === null ? null : roundToInt(projected),
      target,
      rateNeededForTarget: needed === null ? null : roundTo(needed, 1),
      status,
      note,
      evenPacePerDay: target === null ? roundTo(even, 1) : null,
      previousWindowEndedAt: previous === null ? null : previous[1],
      banked: bank,
      ...lane,
      laneBinding: false,
      observedAt: isoUtc(w.observedAt),
      tokenCost,
    });
    if (farBelow(w, aim, horizon, now)) {
      roomy.add(w.name);
    }
  }
  bindingLane(out, roomy).laneBinding = true;
  return out;
}

/** The lanes one source supports: [more lanes, per-lane rate, window that binds]; more is null while unmeasured. */
export function laneSummary(res: readonly WindowAssessment[]): [number | null, number | null, string] {
  const a = res.find((x) => x.laneBinding) as WindowAssessment;
  return [a.laneHeadroom, a.perLaneRate, a.window];
}
