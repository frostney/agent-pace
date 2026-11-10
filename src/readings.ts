import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assess, type PaceOptions, type WindowAssessment } from "./assess.ts";
import { CLAUDE_WINDOWS, claudeReading, fetchFailure } from "./claude.ts";
import { codexReading } from "./codex.ts";
import { withLock } from "./file-lock.ts";
import { CREDITS_LOG, logPath, read, record } from "./history.ts";
import type { Host } from "./host.ts";
import { hubLogin, hubReading, poolMembers, poolWindows } from "./hub.ts";
import { laneReading } from "./lanes.ts";
import { dumps, float, isRecord, type Json } from "./python-json.ts";
import { tokenReading } from "./token-ledger.ts";
import type {
  Banked,
  Credit,
  HistoryKey,
  HubPool,
  Reading,
  ReadingWithLanes,
  Source,
  UsageCredits,
  UsageWindow,
} from "./usage.ts";

/** The banked resets as the sidecar file holds them (Python's json.dump of the same dict). */
export function bankedRecord(banked: Banked | null): Json {
  if (banked === null) {
    return null;
  }
  const credits =
    banked.credits === null
      ? null
      : banked.credits.map((c) => ({
          expires_at: float(c.expiresAt),
          title: c.title,
          clears: c.clears,
        }));
  return { count: banked.count, credits };
}

function parseCredit(value: unknown): Credit | null {
  if (!isRecord(value)) {
    return null;
  }
  const { expires_at: expiresAt, title, clears } = value;
  if (expiresAt !== null && typeof expiresAt !== "number") {
    return null;
  }
  if (clears !== null && !(Array.isArray(clears) && clears.every((c) => typeof c === "string"))) {
    return null;
  }
  // decoded by JSON.parse, so it is JSON
  return { expiresAt, title: (title ?? null) as Json, clears };
}

function parseBanked(value: unknown): Banked | null {
  if (!isRecord(value) || typeof value.count !== "number") {
    return null;
  }
  if (value.credits === null) {
    return { count: value.count, credits: null };
  }
  if (!Array.isArray(value.credits)) {
    return null;
  }
  const credits = value.credits.map(parseCredit);
  if (credits.some((c) => c === null)) {
    return null;
  }
  return { count: value.count, credits: credits.filter((c): c is Credit => c !== null) };
}

/** The usage credits as the sidecar file holds them. */
function creditsRecord(credits: UsageCredits | null): Json {
  if (credits === null) {
    return null;
  }
  return {
    left: float(credits.left),
    spent: float(credits.spent),
    unit: credits.unit,
    places: credits.places,
  };
}

function parseCredits(value: unknown): UsageCredits | null {
  if (!isRecord(value)) {
    return null;
  }
  const { left, spent, unit, places } = value;
  if ((left !== null && typeof left !== "number") || typeof spent !== "number" || typeof unit !== "string") {
    return null;
  }
  return { left, spent, unit, places: typeof places === "number" ? places : 2 };
}

/** The banked resets and credits stored with the last reading (the history only holds windows). */
function readSidecar(state: string, source: Source): Pick<Reading, "banked" | "note" | "credits"> {
  try {
    const side: unknown = JSON.parse(readFileSync(join(state, `${source}-banked.json`), "utf8"));
    if (isRecord(side)) {
      const note = typeof side.note === "string" ? side.note : null;
      return { banked: parseBanked(side.banked), note, credits: parseCredits(side.credits) };
    }
  } catch {
    // no sidecar yet
  }
  return { banked: null, note: null, credits: null };
}

function writeSidecar(state: string, source: Source, reading: Reading): void {
  const path = join(state, `${source}-banked.json`);
  try {
    const side = {
      banked: bankedRecord(reading.banked),
      note: reading.note,
      credits: creditsRecord(reading.credits),
    };
    writeFileSync(`${path}.tmp`, dumps(side));
    renameSync(`${path}.tmp`, path);
  } catch {
    // the next reading stores them
  }
}

/** What the credits have spent, kept beside the windows so their draw can be measured as a window's burn is. */
function recordCredits(
  state: string,
  source: Source,
  credits: UsageCredits | null,
  at: number,
  minGap = 0,
): void {
  if (credits !== null) {
    record(
      state,
      source,
      { name: CREDITS_LOG, used: credits.spent, resetsAt: 0, lengthS: 0, observedAt: at },
      minGap,
    );
  }
}

/** Windows rebuilt from readings under maxAge seconds old, so repeated calls don't hit the endpoint. */
function cached(state: string, source: Source, now: number, maxAge = 60): UsageWindow[] | null {
  const out: UsageWindow[] = [];
  for (const { name, lengthS } of CLAUDE_WINDOWS) {
    const last = read(logPath(state, source, name)).at(-1);
    if (last === undefined) {
      continue;
    }
    if (now - last[0] > maxAge) {
      return null;
    }
    const [t, used, resetsAt] = last;
    out.push({ name, used, resetsAt, lengthS, observedAt: t });
  }
  return out.length > 0 ? out : null;
}

/** One reading per minute per machine, however many watchers run: the first caller fetches under a lock. */
async function fetchShared(
  state: string,
  source: Source,
  fetchReading: () => Promise<Reading>,
  host: Host,
): Promise<Reading> {
  mkdirSync(state, { recursive: true });
  return withLock(join(state, `.${source}.lock`), async () => {
    const hit = cached(state, source, host.now());
    if (hit) {
      return { windows: hit, via: "usage-api", ...readSidecar(state, source) };
    }
    const reading = await fetchReading();
    for (const w of reading.windows) {
      record(state, source, w);
    }
    recordCredits(state, source, reading.credits, host.now());
    writeSidecar(state, source, reading);
    return reading;
  });
}

async function readClaude(state: string, host: Host): Promise<ReadingWithLanes> {
  const reading = await fetchShared(state, "claude", () => claudeReading(state, host), host);
  return {
    ...reading,
    lanes: await laneReading(state, "claude", host),
    tokens: await tokenReading(state, "claude", host),
  };
}

async function readCodex(state: string, host: Host): Promise<ReadingWithLanes> {
  const { windows, banked, via, credits } = await codexReading(host);
  for (const w of windows) {
    record(state, "codex", w, 60); // a reading per call, but at most a row a minute
  }
  recordCredits(state, "codex", credits, windows[0]?.observedAt ?? host.now(), 60);
  let note: string | null = null;
  if (banked === null) {
    note =
      via === "session-logs"
        ? "banked resets unknown (Codex app server unavailable; read the session logs)"
        : "banked resets unknown (the Codex app server reported none)";
  }
  return {
    windows,
    banked,
    note,
    via,
    credits,
    lanes: await laneReading(state, "codex", host),
    tokens: await tokenReading(state, "codex", host),
  };
}

/**
 * Starts the pool's history over when its accounts or their shares changed since the last
 * reading (`<source>-pool-members`): an account joining or leaving moves the pool's use by more
 * than it burned, which the history would read as burn.
 */
function keepPoolMembers(state: string, source: Source, pool: HubPool): void {
  const path = join(state, `${source}-pool-members`);
  const members = poolMembers(pool);
  let before: string | null = null;
  try {
    before = readFileSync(path, "utf8");
  } catch {
    before = null;
  }
  if (before === members) {
    return;
  }
  mkdirSync(state, { recursive: true });
  if (before !== null) {
    for (const name of readdirSync(state)) {
      if (name.startsWith(`${source}-pool-`) && name.endsWith(".csv")) {
        rmSync(join(state, name), { force: true });
      }
    }
  }
  writeFileSync(path, members);
}

/**
 * A hub client's reading: the pool of the hub's accounts, kept in its own history
 * (`<source>-pool-<window>.csv`); the lanes are this machine's, as without a hub.
 */
async function readPool(source: Source, pool: HubPool, state: string, host: Host): Promise<ReadingWithLanes> {
  const windows = poolWindows(source, pool, host.now());
  keepPoolMembers(state, source, pool);
  for (const w of windows) {
    record(state, `${source}-pool`, w, 60); // the hub caches a minute: at most a row a minute
  }
  return {
    windows,
    banked: null, // each account's own; the pool's pacing does not count on them
    note: null,
    via: "hub",
    credits: null,
    lanes: await laneReading(state, source, host),
    tokens: await tokenReading(state, source, host),
    pool,
  };
}

/**
 * A source's reading: the hub's pool when this machine's Claude Code or Codex goes through a
 * hub that runs `agent-pace hub serve`, this machine's own otherwise.
 */
export async function readSource(source: Source, state: string, host: Host): Promise<ReadingWithLanes> {
  const login = hubLogin(source, host);
  const pool =
    login === null
      ? null
      : await hubReading(source, login, state, host, (error) => fetchFailure(error, host));
  if (pool !== null) {
    return readPool(source, pool, state, host);
  }
  return source === "claude" ? readClaude(state, host) : readCodex(state, host);
}

/** Whose history a reading's windows are kept in. */
export function historyKey(source: Source, reading: ReadingWithLanes): HistoryKey {
  return reading.pool ? `${source}-pool` : source;
}

/**
 * A reading assessed against its history. A pool's windows move their reset each time one of
 * its accounts resets, which is no end of the pool's window: a pool says nothing of a
 * previous window.
 */
export function assessReading(
  source: Source,
  reading: ReadingWithLanes,
  options: PaceOptions,
  now: number,
): WindowAssessment[] {
  const res = assess(
    historyKey(source, reading),
    reading.windows,
    options,
    reading.banked,
    reading.lanes,
    now,
    reading.tokens,
    reading.credits,
  );
  return reading.pool ? res.map((a) => ({ ...a, previousWindowEndedAt: null })) : res;
}
