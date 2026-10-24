// Each lane's burn measured from its own tokens: what its requests would cost at list prices
// (src/token-prices.ts) times how many window points a dollar of that has been worth.
//
// The points per dollar of a window are learned from agent-pace's own history of it. The
// readings of one window instance, cut at any drop in use (a reset), make runs. A run from its
// first reading to its last moved Δu whole points while the local lanes spent D dollars, so
//
//     points per dollar = Σ Δu / Σ D        over the runs of the last week.
//
// Each run's Δu is a difference of whole points, so it is off by up to one point; over n runs
// the sum is off by up to n. The fit counts once Σ Δu is at least EVIDENCE_POINTS times n,
// which keeps that error within a third, the bar a recent rate has to clear. A run in which no
// local lane spent anything (another machine or claude.ai moved the window) says nothing about
// what a local lane costs and is left out. Use from elsewhere during a run is counted against
// the local lanes, as the shared-out estimate counts it.

import { EVIDENCE_POINTS } from "./evidence.ts";
import { type HistoryRow, RESET_JITTER_S } from "./history.ts";
import { LANE_IDLE_S } from "./lanes.ts";
import type { TokenUse } from "./token-ledger.ts";

/** How far back a lane's own spending is averaged into its rate. */
export const LANE_RATE_SPAN_S = 1800;
/** A lane that has spent for less than this is averaged over this much. */
const MIN_LANE_SPAN_S = 300;
/**
 * A run whose local lanes spent less than this share of what a point usually costs them was
 * moved mostly by something else.
 */
const MIN_COST_SHARE = 0.05;
/** A run shorter than this says little: two readings close together. */
const MIN_RUN_S = 540;

export interface TokenCost {
  readonly pointsPerDollar: number;
  readonly runs: number;
  readonly points: number;
  readonly dollars: number;
}

interface Run {
  readonly t0: number;
  readonly t1: number;
  readonly du: number;
}

/** The runs of a window's history: readings of one instance, between drops in use. */
function runs(rows: readonly HistoryRow[]): Run[] {
  const out: Run[] = [];
  let first: HistoryRow | undefined;
  let last: HistoryRow | undefined;
  const close = () => {
    if (first && last && last[0] - first[0] >= MIN_RUN_S) {
      out.push({ t0: first[0], t1: last[0], du: last[1] - first[1] });
    }
  };
  for (const row of rows) {
    if (last && (Math.abs(row[2] - last[2]) >= RESET_JITTER_S || row[1] < last[1])) {
      close();
      first = row;
    }
    first ??= row;
    last = row;
  }
  close();
  return out;
}

/** How many points of a window a dollar of local spending has been worth; null while unlearned. */
export function fitTokenCost(rows: readonly HistoryRow[], use: TokenUse): TokenCost | null {
  // runs since the ledger knew every lane's spending: a week back and a day, so the week that
  // just ended still teaches the 7d window until the new one has moved
  const known = runs(rows)
    .filter((run) => run.t0 >= use.since)
    .map((run) => ({ ...run, spent: use.spent(run.t0, run.t1) }))
    .filter((run) => run.spent > 0);
  // what a point usually costs the local lanes: the median over the runs that moved
  const perPoint = known
    .filter((run) => run.du > 0)
    .map((run) => run.spent / run.du)
    .sort((a, b) => a - b);
  const middle = perPoint.length / 2;
  const usual =
    perPoint.length === 0
      ? 0
      : ((perPoint[Math.floor(middle - 0.5)] ?? 0) + (perPoint[Math.floor(middle)] ?? 0)) / 2;
  let points = 0;
  let dollars = 0;
  let counted = 0;
  for (const run of known) {
    if (run.du > 0 && run.spent / run.du < MIN_COST_SHARE * usual) {
      continue; // the lanes here barely spent for the points: whatever moved the window, it was not them
    }
    points += run.du;
    dollars += run.spent;
    counted += 1;
  }
  if (counted === 0 || points < EVIDENCE_POINTS * counted) {
    return null;
  }
  return { pointsPerDollar: points / dollars, runs: counted, points, dollars };
}

/**
 * The burn (%/h of the window) of each lane that spent in the last LANE_IDLE_S: its spending
 * over the last LANE_RATE_SPAN_S, or since it started if that is later, times points per dollar.
 * A lane that spent nothing lately is not working, whatever its session file says.
 */
export function laneRates(use: TokenUse, fit: TokenCost, now: number): number[] {
  const active = use.byLane(now - LANE_IDLE_S, now);
  const rates: number[] = [];
  for (const [lane, { dollars, first }] of use.byLane(now - LANE_RATE_SPAN_S, now)) {
    if (!((active.get(lane)?.dollars ?? 0) > 0)) {
      continue;
    }
    const span = Math.max(MIN_LANE_SPAN_S, now - Math.max(now - LANE_RATE_SPAN_S, first));
    rates.push((dollars * fit.pointsPerDollar) / (span / 3600));
  }
  return rates.sort((a, b) => b - a);
}
