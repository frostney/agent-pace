import type { Json } from "./python-json.ts";

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

export type Via = "usage-api" | "app-server" | "session-logs";

/** A source's reading: its windows and banked resets (null when they cannot be known). */
export interface Reading {
  readonly windows: readonly UsageWindow[];
  readonly banked: Banked | null;
  readonly note: string | null;
  readonly via: Via;
}

export interface ReadingWithLanes extends Reading {
  readonly lanes: LaneReading;
}
