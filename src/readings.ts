import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_WINDOWS, claudeReading } from "./claude.ts";
import { codexReading } from "./codex.ts";
import { withLock } from "./file-lock.ts";
import { logPath, read, record } from "./history.ts";
import type { Host } from "./host.ts";
import { laneReading } from "./lanes.ts";
import { dumps, float, isRecord, type Json } from "./python-json.ts";
import type { Banked, Credit, Reading, ReadingWithLanes, Source, UsageWindow } from "./usage.ts";

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

/** The banked resets stored with the last reading (the history only holds windows). */
function readSidecar(state: string, source: Source): Pick<Reading, "banked" | "note"> {
  try {
    const side: unknown = JSON.parse(readFileSync(join(state, `${source}-banked.json`), "utf8"));
    if (isRecord(side)) {
      const note = typeof side.note === "string" ? side.note : null;
      return { banked: parseBanked(side.banked), note };
    }
  } catch {
    // no sidecar yet
  }
  return { banked: null, note: null };
}

function writeSidecar(state: string, source: Source, reading: Reading): void {
  const path = join(state, `${source}-banked.json`);
  try {
    writeFileSync(`${path}.tmp`, dumps({ banked: bankedRecord(reading.banked), note: reading.note }));
    renameSync(`${path}.tmp`, path);
  } catch {
    // the next reading stores them
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
    writeSidecar(state, source, reading);
    return reading;
  });
}

async function readClaude(state: string, host: Host): Promise<ReadingWithLanes> {
  const reading = await fetchShared(state, "claude", () => claudeReading(state, host), host);
  return { ...reading, lanes: await laneReading(state, "claude", host) };
}

async function readCodex(state: string, host: Host): Promise<ReadingWithLanes> {
  const { windows, banked, via } = await codexReading(host);
  for (const w of windows) {
    record(state, "codex", w, 60); // a reading per call, but at most a row a minute
  }
  let note: string | null = null;
  if (banked === null) {
    note =
      via === "session-logs"
        ? "banked resets unknown (Codex app server unavailable; read the session logs)"
        : "banked resets unknown (the Codex app server reported none)";
  }
  return { windows, banked, note, via, lanes: await laneReading(state, "codex", host) };
}

export function readSource(source: Source, state: string, host: Host): Promise<ReadingWithLanes> {
  return source === "claude" ? readClaude(state, host) : readCodex(state, host);
}
