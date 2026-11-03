import type { Json } from "./python-json.ts";
import type { TokenUse } from "./token-ledger.ts";

export type Source = "claude" | "codex";
export const SOURCES: readonly Source[] = ["claude", "codex"];

/** One usage window as a source reports it. Times are unix seconds. */
export interface UsageWindow {
  readonly name: string;
  readonly used: number;
  readonly resetsAt: number;
  readonly lengthS: number;
  readonly observedAt: number;
}

/** A banked reset. `clears` names the windows it refills; null for a Codex reset, which clears all. */
export interface Credit {
  readonly expiresAt: number | null;
  readonly title: Json;
  readonly clears: readonly string[] | null;
}

/** The banked resets on an account; `credits` is null when only the count is known. */
export interface Banked {
  readonly count: number;
  readonly credits: readonly Credit[] | null;
}

/** The lanes working now and the counts remembered at earlier readings: [time, lanes]. */
export interface LaneReading {
  readonly active: number;
  readonly rows: readonly (readonly [number, number])[];
  readonly at: number;
}

/**
 * The usage credits on an account: what it can keep spending once a window is at its limit
 * (Claude's extra usage, Codex credits). Amounts are in `unit`: a currency, or Codex credits.
 */
export interface UsageCredits {
  /** What is left to spend; null when nothing caps it. */
  readonly left: number | null;
  /** A counter that rises as the credits are drawn, for measuring the draw (a top-up or a new month can lower it). */
  readonly spent: number;
  readonly unit: string;
  /** The decimal places the amounts are shown with. */
  readonly places: number;
}

export type Via = "usage-api" | "app-server" | "session-logs";

/** A source's reading: its windows and banked resets (null when they cannot be known). */
export interface Reading {
  readonly windows: readonly UsageWindow[];
  readonly banked: Banked | null;
  readonly note: string | null;
  readonly via: Via;
  /** The usage credits; null when the account has none to draw on, or they cannot be known. */
  readonly credits: UsageCredits | null;
}

export interface ReadingWithLanes extends Reading {
  readonly lanes: LaneReading;
  /** What each lane spent lately, from the agents' session files; null without a ledger. */
  readonly tokens: TokenUse | null;
}
