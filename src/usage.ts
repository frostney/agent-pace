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
  /**
   * A hub pool's window only: [when, points] for each account that resets before the pool's
   * window does, handing back at least the points it has used (as points of the pool).
   */
  readonly returns?: readonly (readonly [at: number, points: number])[];
}

/** A banked reset. `clears` names the windows it refills; null for a Codex reset, which clears all. */
export interface Credit {
  readonly expiresAt: number | null;
  readonly title: Json;
  readonly clears: readonly string[] | null;
  /**
   * A hub pool's reset only: the points of the pool its account has left in the window the
   * reset is spent on, which is all that has to be filled before it expires.
   */
  readonly fill?: number;
  /**
   * A hub pool's reset only: when its account's window resets on its own. A reset that expires
   * after that is not at risk, as on one login; one that expires before it only needs its
   * account filled. Undefined while the account has not started that window.
   */
  readonly ownerResetsAt?: number;
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

export type Via = "usage-api" | "app-server" | "session-logs" | "hub";

/** Whose readings a history file holds: this machine's login (`claude`) or a hub's pool (`claude-pool`). */
export type HistoryKey = Source | `${Source}-pool`;

/** An account on a CLIProxyAPI hub: read (`ok`), turned off on the hub, or not readable now. */
export type HubAccountState = "ok" | "disabled" | "unreadable";

/** One account on the hub as `agent-pace hub serve` reports it. */
export interface HubAccount {
  /** The credential's note on the hub, or the provider and its place in the hub's list. */
  readonly label: string;
  /** The plan the provider names (Codex), or null. */
  readonly plan: string | null;
  /** The credential's weight on the hub; null when it sets none. */
  readonly weight: number | null;
  readonly state: HubAccountState;
  /** Why it is unreadable, or why its reading is an older one, such as "HTTP 429"; null otherwise. */
  readonly detail: string | null;
  /** When its windows were read; earlier than the pool's reading when the last read failed. */
  readonly readAt: number | null;
  /** The hub has stopped routing to it for now (a cooldown, often a limit reached). */
  readonly coolingDown: boolean;
  readonly windows: readonly UsageWindow[];
  /** The windows its plan limits, started or not; null when the hub does not say (before 5.2). */
  readonly limits: readonly string[] | null;
  /** Its banked resets; null when they cannot be known. */
  readonly banked: Banked | null;
}

/** A provider's accounts on the hub, read at once. */
export interface HubPool {
  /** The hub's address, as this machine's Claude Code or Codex reaches it. */
  readonly url: string;
  readonly observedAt: number;
  readonly accounts: readonly HubAccount[];
}

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
  /** On a hub client: the accounts the windows pool. */
  readonly pool?: HubPool;
}
