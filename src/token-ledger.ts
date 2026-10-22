// What each lane spent, minute by minute, read from the agents' own session files. Claude Code
// writes a `usage` block on each assistant message; Codex writes a `token_usage_record` per
// response. The ledger keeps the cost of each lane per minute for the last eight days in
// tokens-<source>.json, with how far into each file it has read, so a reading parses only
// what was appended since the last one.

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { isSystemError } from "./errors.ts";
import { withLock } from "./file-lock.ts";
import { claudeHome, codexHome, type Host } from "./host.ts";
import { get, isRecord, toFloat } from "./python-json.ts";
import { parseIso } from "./time-format.ts";
import { claudePrice, codexPrice, cost, type Tokens } from "./token-prices.ts";
import type { Source } from "./usage.ts";

/** How long the ledger keeps a lane's costs: a week's window, and a day to fit it. */
export const LEDGER_SPAN_S = 8 * 86400;
const RECENT_IDS = 64;
const CHUNK = 1 << 22;

interface Cursor {
  /** Bytes read so far: the start of the first line not yet read. */
  offset: number;
  /** Message or response ids counted lately: one Claude message spans several lines. */
  recent: string[];
  /** The model of the current Codex turn, which turn_context lines set. */
  model: string | null;
}

/** [minute (unix seconds), lane, dollars] */
type Bucket = [number, number, number];

interface LedgerFile {
  version: 1;
  /** From when the ledger has every lane's costs. */
  since: number;
  lanes: string[];
  files: Record<string, Cursor>;
  buckets: Bucket[];
}

/** One request's cost at a moment, from one line of a session file. */
interface Spend {
  readonly id: string;
  readonly t: number;
  readonly dollars: number;
}

function count(value: unknown): number {
  try {
    const n = toFloat(value ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function claudeSpend(line: string): Spend | null {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) {
    return null;
  }
  const event: unknown = JSON.parse(line);
  const message = isRecord(event) ? get(event, "message") : null;
  const usage = isRecord(message) ? get(message, "usage") : null;
  const id = isRecord(message) ? get(message, "id") : null;
  const timestamp = isRecord(event) ? get(event, "timestamp") : null;
  if (!isRecord(usage) || typeof id !== "string" || typeof timestamp !== "string") {
    return null;
  }
  const model = get(message, "model");
  const created = count(get(usage, "cache_creation_input_tokens"));
  const split = get(usage, "cache_creation");
  const write1h = isRecord(split) ? count(get(split, "ephemeral_1h_input_tokens")) : 0;
  const tokens: Tokens = {
    input: count(get(usage, "input_tokens")),
    output: count(get(usage, "output_tokens")),
    cacheRead: count(get(usage, "cache_read_input_tokens")),
    cacheWrite1h: write1h,
    cacheWrite5m: Math.max(0, created - write1h),
  };
  const price = claudePrice(typeof model === "string" ? model : "");
  return { id, t: parseIso(timestamp.replaceAll("Z", "+00:00")), dollars: cost(tokens, price) };
}

function codexSpend(line: string, cursor: Cursor): Spend | null {
  if (line.includes('"turn_context"')) {
    const event: unknown = JSON.parse(line);
    const model = isRecord(event) ? get(get(event, "payload") ?? {}, "model") : null;
    cursor.model = typeof model === "string" ? model : cursor.model;
    return null;
  }
  if (!line.includes('"token_usage_record"')) {
    return null;
  }
  const event: unknown = JSON.parse(line);
  const payload = isRecord(event) ? get(event, "payload") : null;
  const usage = isRecord(payload) ? get(payload, "usage") : null;
  const id = isRecord(payload) ? get(payload, "response_id") : null;
  const timestamp = isRecord(event) ? get(event, "timestamp") : null;
  if (!isRecord(usage) || typeof id !== "string" || typeof timestamp !== "string") {
    return null;
  }
  const input = count(get(usage, "input_tokens"));
  const cached = count(get(usage, "cached_input_tokens"));
  const tokens: Tokens = {
    input: Math.max(0, input - cached),
    output: count(get(usage, "output_tokens")),
    cacheRead: cached,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
  return { id, t: parseIso(timestamp.replaceAll("Z", "+00:00")), dollars: cost(tokens, codexPrice()) };
}

/** Session files under root written since `after`, by path. */
function sessionFiles(root: string, after: number, source: Source): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        (source === "claude" || entry.name.startsWith("rollout-"))
      ) {
        out.set(path, 0);
      }
    }
  };
  walk(root);
  for (const path of out.keys()) {
    try {
      const fd = openSync(path, "r");
      try {
        const stat = fstatSync(fd);
        if (stat.mtimeMs / 1000 < after) {
          out.delete(path);
        } else {
          out.set(path, stat.size);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      out.delete(path);
    }
  }
  return out;
}

/** The complete lines of path from offset on, and where the next unread line starts. */
function* newLines(path: string, offset: number, size: number): Generator<string, void, undefined> {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, size - offset)));
    let position = offset;
    let pending = "";
    while (position < size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (n === 0) {
        break;
      }
      position += n;
      const text = pending + buffer.toString("utf8", 0, n);
      const lines = text.split("\n");
      pending = lines.pop() ?? "";
      yield* lines;
    }
  } finally {
    closeSync(fd);
  }
}

function emptyLedger(now: number): LedgerFile {
  return { version: 1, since: now - LEDGER_SPAN_S, lanes: [], files: {}, buckets: [] };
}

function loadLedger(path: string, now: number): LedgerFile {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      isRecord(data) &&
      data.version === 1 &&
      Array.isArray(data.buckets) &&
      Array.isArray(data.lanes) &&
      isRecord(data.files) &&
      typeof data.since === "number"
    ) {
      // written by this module, so it has the shape it wrote
      return data as unknown as LedgerFile;
    }
  } catch {
    // no ledger yet, or a damaged one: start again
  }
  return emptyLedger(now);
}

/** Reads what the lanes spent since the last reading into the ledger and returns it. */
function update(ledger: LedgerFile, source: Source, root: string, now: number): void {
  const horizon = now - LEDGER_SPAN_S;
  const files = sessionFiles(root, horizon, source);
  const buckets = new Map<string, number>(ledger.buckets.map(([m, l, d]) => [`${m}:${l}`, d]));
  const laneIndex = new Map(ledger.lanes.map((lane, i) => [lane, i]));
  for (const [path, size] of files) {
    const lane = relative(root, path);
    let cursor = ledger.files[lane];
    if (cursor === undefined || size < cursor.offset) {
      cursor = { offset: 0, recent: [], model: null }; // new, or rewritten from the start
    }
    let index = laneIndex.get(lane);
    if (index === undefined) {
      index = ledger.lanes.length;
      ledger.lanes.push(lane);
      laneIndex.set(lane, index);
    }
    let read = cursor.offset;
    for (const line of newLines(path, cursor.offset, size)) {
      read += Buffer.byteLength(line, "utf8") + 1;
      let spend: Spend | null = null;
      try {
        spend = source === "claude" ? claudeSpend(line) : codexSpend(line, cursor);
      } catch {
        spend = null; // a line agent-pace does not understand costs nothing
      }
      if (spend === null || spend.t < horizon || cursor.recent.includes(spend.id)) {
        continue;
      }
      cursor.recent.push(spend.id);
      if (cursor.recent.length > RECENT_IDS) {
        cursor.recent.shift();
      }
      const key = `${Math.floor(spend.t / 60) * 60}:${index}`;
      buckets.set(key, (buckets.get(key) ?? 0) + spend.dollars);
    }
    cursor.offset = read;
    ledger.files[lane] = cursor;
  }
  for (const lane of Object.keys(ledger.files)) {
    if (!files.has(join(root, lane))) {
      delete ledger.files[lane]; // gone, or untouched for longer than the ledger keeps
    }
  }
  const kept = [...buckets]
    .map(([key, dollars]): Bucket => {
      const [minute = 0, lane = 0] = key.split(":").map(Number);
      return [minute, lane, Math.round(dollars * 1e6) / 1e6];
    })
    .filter(([minute]) => minute >= horizon);
  // keep only the lanes something still refers to, renumbered
  const old = ledger.lanes;
  const used = new Set([...kept.map(([, lane]) => old[lane]), ...Object.keys(ledger.files)]);
  ledger.lanes = old.filter((lane) => used.has(lane));
  const renumber = new Map(ledger.lanes.map((lane, i) => [lane, i]));
  ledger.buckets = kept
    .map(([minute, lane, dollars]): Bucket => [minute, renumber.get(old[lane] ?? "") ?? 0, dollars])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  ledger.since = Math.max(ledger.since, horizon);
}

/** What the lanes of one source spent, by minute, as one reading sees it. */
export class TokenUse {
  private readonly prefix: number[];

  constructor(
    /** From when every lane's spending is known. */
    readonly since: number,
    private readonly buckets: readonly Bucket[],
    private readonly lanes: readonly string[],
  ) {
    this.prefix = [0];
    for (const [, , dollars] of buckets) {
      this.prefix.push((this.prefix.at(-1) ?? 0) + dollars);
    }
  }

  /** The first bucket at or after minute t. */
  private lowerBound(t: number): number {
    let lo = 0;
    let hi = this.buckets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.buckets[mid] as Bucket)[0] < t) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Dollars all lanes spent in the minutes whose middle falls in (since, until]. */
  spent(since: number, until: number): number {
    const from = this.lowerBound(Math.floor((since - 30) / 60) * 60 + 60);
    const to = this.lowerBound(Math.floor((until - 30) / 60) * 60 + 60);
    return (this.prefix[to] ?? 0) - (this.prefix[from] ?? 0);
  }

  /** Each lane's dollars in (since, until] and the first minute it spent in them. */
  byLane(since: number, until: number): Map<string, { dollars: number; first: number }> {
    const out = new Map<string, { dollars: number; first: number }>();
    const from = this.lowerBound(Math.floor((since - 30) / 60) * 60 + 60);
    for (let i = from; i < this.buckets.length; i++) {
      const [minute, lane, dollars] = this.buckets[i] as Bucket;
      if (minute + 30 > until) {
        break;
      }
      const name = this.lanes[lane] ?? String(lane);
      const seen = out.get(name);
      out.set(name, { dollars: (seen?.dollars ?? 0) + dollars, first: seen ? seen.first : minute });
    }
    return out;
  }
}

/** Brings the ledger of a source up to date and returns what it holds. */
export async function tokenReading(state: string, source: Source, host: Host): Promise<TokenUse | null> {
  const now = host.now();
  const root =
    source === "claude" ? join(claudeHome(host.env), "projects") : join(codexHome(host.env), "sessions");
  const path = join(state, `tokens-${source}.json`);
  try {
    mkdirSync(state, { recursive: true });
    return await withLock(join(state, `.tokens-${source}.lock`), () => {
      const ledger = loadLedger(path, now);
      update(ledger, source, root, now);
      writeFileSync(`${path}.tmp`, JSON.stringify(ledger));
      renameSync(`${path}.tmp`, path);
      return new TokenUse(ledger.since, ledger.buckets, ledger.lanes);
    });
  } catch (error) {
    if (isSystemError(error)) {
      return null; // no ledger this reading: the lanes are shared out as before
    }
    throw error;
  }
}
