// What each lane spent, minute by minute, read from the agents' own session files. Claude Code
// writes a `usage` block on each assistant message; Codex writes a `token_usage_record` per
// response. The ledger keeps the cost of each lane per minute for the last eight days in
// tokens-<source>.json, with how far into each file it has read, so a reading parses only
// what was appended since the last one.
//
// One request can appear more than once. Claude Code writes each content block of a message
// on its own line with the message's usage, and the last line carries the final output count;
// a forked or resumed session copies earlier messages into a new file. So the ledger counts
// each request once, at the largest cost any of its lines gives, in the lane that first wrote
// it.
//
// A Codex usage record does not name its model or service tier; the thread's latest
// turn_context and thread_settings_applied lines before it do, so the ledger carries them
// along each rollout file from one reading to the next.

import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { isSystemError } from "./errors.ts";
import { withLock } from "./file-lock.ts";
import { claudeHome, codexHome, type Host } from "./host.ts";
import { get, isRecord, toFloat } from "./python-json.ts";
import { parseIso } from "./time-format.ts";
import { claudePrice, codexPrice, codexTierFactor, cost, type Tokens } from "./token-prices.ts";
import type { Source } from "./usage.ts";

/** How long the ledger keeps a lane's costs: a week's window, and a day to fit it. */
export const LEDGER_SPAN_S = 8 * 86400;
const CHUNK = 1 << 22;
const NEWLINE = 0x0a;

/** [minute (unix seconds), lane, dollars] */
type Bucket = [number, number, number];
/** A request already counted: [minute, lane, dollars counted]. */
type Seen = [number, number, number];
/** The model and service tier a Codex rollout's requests run at so far. */
type CodexSetting = [string, string];

interface LedgerFile {
  version: 3;
  /** From when the ledger has every lane's costs. */
  since: number;
  lanes: string[];
  /** Bytes read so far of each session file: the start of the first line not yet read. */
  offsets: Record<string, number>;
  /** Each Codex rollout's setting as of its offset. */
  settings: Record<string, CodexSetting>;
  /** The requests counted, by a hash of their id. */
  seen: Record<string, Seen>;
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

function timeOf(value: unknown): number | null {
  return typeof value === "string" ? parseIso(value.replaceAll("Z", "+00:00")) : null;
}

function claudeSpend(line: string): Spend | null {
  if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) {
    return null;
  }
  const event: unknown = JSON.parse(line);
  const message = isRecord(event) ? get(event, "message") : null;
  const usage = isRecord(message) ? get(message, "usage") : null;
  const id = isRecord(message) ? get(message, "id") : null;
  const t = isRecord(event) ? timeOf(get(event, "timestamp")) : null;
  if (!isRecord(usage) || typeof id !== "string" || t === null) {
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
    cacheWriteShort: Math.max(0, created - write1h),
    cacheWriteLong: write1h,
  };
  // fast mode runs the same model at twice its price
  const speed = get(usage, "speed") === "fast" ? 2 : 1;
  return { id, t, dollars: speed * cost(tokens, claudePrice(typeof model === "string" ? model : "")) };
}

function codexSpend(line: string, setting: CodexSetting): Spend | null {
  if (line.includes('"turn_context"') || line.includes('"thread_settings_applied"')) {
    const event: unknown = JSON.parse(line);
    const payload = isRecord(event) ? get(event, "payload") : null;
    if (!isRecord(payload)) {
      return null;
    }
    const applied = get(payload, "type") === "thread_settings_applied";
    const settings = applied
      ? get(payload, "thread_settings")
      : get(event, "type") === "turn_context"
        ? payload
        : null;
    if (!isRecord(settings)) {
      return null; // a line that only mentions them
    }
    const model = get(settings, "model");
    if (typeof model === "string") {
      setting[0] = model;
    }
    if (applied) {
      const tier = get(settings, "service_tier");
      setting[1] = typeof tier === "string" ? tier : "default";
    }
    return null;
  }
  if (!line.includes('"token_usage_record"')) {
    return null;
  }
  const event: unknown = JSON.parse(line);
  const payload = isRecord(event) ? get(event, "payload") : null;
  const usage = isRecord(payload) ? get(payload, "usage") : null;
  const id = isRecord(payload) ? get(payload, "response_id") : null;
  const t = isRecord(event) ? timeOf(get(event, "timestamp")) : null;
  if (!isRecord(usage) || typeof id !== "string" || t === null) {
    return null;
  }
  // input_tokens counts the whole prompt: the cached tokens and the cache writes are part of it
  const prompt = count(get(usage, "input_tokens"));
  const cached = count(get(usage, "cached_input_tokens"));
  const written = count(get(usage, "cache_write_input_tokens"));
  const tokens: Tokens = {
    input: Math.max(0, prompt - cached - written),
    output: count(get(usage, "output_tokens")),
    cacheRead: cached,
    // Codex sets no cache lifetime, so a write lasts the default 30 minutes
    cacheWriteShort: written,
    cacheWriteLong: 0,
  };
  const [model, tier] = setting;
  return { id, t, dollars: codexTierFactor(tier) * cost(tokens, codexPrice(model, prompt)) };
}

/** A 52-bit FNV-1a hash of a request id, in base 36: short to store, collision-free in practice. */
function idKey(id: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < id.length; i++) {
    hash ^= BigInt(id.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return (hash >> 12n).toString(36);
}

/**
 * Session files under root written since `after`, with their sizes, oldest first: on a first
 * reading a request a fork copied is then counted in the session that wrote it. Links to files
 * are read; linked directories are not entered, as lane counting does not enter them.
 */
function sessionFiles(root: string, after: number, source: Source): Map<string, number> {
  const found: { path: string; size: number; born: number }[] = [];
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let stat: import("node:fs").Stats;
      let link = false;
      try {
        link = lstatSync(path).isSymbolicLink();
        stat = statSync(path);
      } catch {
        continue; // gone, or a link to nothing
      }
      if (stat.isDirectory()) {
        if (!link) {
          walk(path);
        }
      } else if (
        stat.isFile() &&
        name.endsWith(".jsonl") &&
        (source === "claude" || name.startsWith("rollout-")) &&
        stat.mtimeMs / 1000 >= after
      ) {
        found.push({ path, size: stat.size, born: stat.birthtimeMs || stat.mtimeMs });
      }
    }
  };
  walk(root);
  found.sort((a, b) => a.born - b.born);
  return new Map(found.map(({ path, size }) => [path, size]));
}

/**
 * The complete lines of path from offset on, each with the offset just after it. Lines are
 * split on bytes, so a character that a read cuts in two is decoded whole.
 */
function* newLines(path: string, offset: number, size: number): Generator<[string, number], void, undefined> {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, size - offset)));
    let position = offset;
    let pending = Buffer.alloc(0);
    let pendingStart = offset;
    while (position < size) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (n === 0) {
        break;
      }
      const bytes =
        pending.length > 0 ? Buffer.concat([pending, buffer.subarray(0, n)]) : buffer.subarray(0, n);
      position += n;
      let start = 0;
      for (let end = bytes.indexOf(NEWLINE); end >= 0; end = bytes.indexOf(NEWLINE, start)) {
        yield [bytes.toString("utf8", start, end), pendingStart + end + 1];
        start = end + 1;
      }
      pendingStart += start;
      pending = Buffer.from(bytes.subarray(start));
    }
  } finally {
    closeSync(fd);
  }
}

function emptyLedger(now: number): LedgerFile {
  return {
    version: 3,
    since: now - LEDGER_SPAN_S,
    lanes: [],
    offsets: {},
    settings: {},
    seen: {},
    buckets: [],
  };
}

function loadLedger(path: string, now: number): LedgerFile {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      isRecord(data) &&
      data.version === 3 &&
      typeof data.since === "number" &&
      Array.isArray(data.lanes) &&
      Array.isArray(data.buckets) &&
      isRecord(data.offsets) &&
      isRecord(data.settings) &&
      isRecord(data.seen)
    ) {
      // written by this module, so it has the shape it wrote
      return data as unknown as LedgerFile;
    }
  } catch {
    // no ledger yet, or a damaged one: start again
  }
  return emptyLedger(now);
}

/** Reads what the lanes spent since the last reading into the ledger. */
function update(ledger: LedgerFile, source: Source, root: string, now: number): void {
  const horizon = now - LEDGER_SPAN_S;
  const files = sessionFiles(root, horizon, source);
  const buckets = new Map<string, number>(ledger.buckets.map(([m, l, d]) => [`${m}:${l}`, d]));
  const laneIndex = new Map(ledger.lanes.map((lane, i) => [lane, i]));
  const add = (minute: number, lane: number, dollars: number) => {
    const key = `${minute}:${lane}`;
    buckets.set(key, (buckets.get(key) ?? 0) + dollars);
  };
  for (const [path, size] of files) {
    const lane = relative(root, path);
    let offset = ledger.offsets[lane] ?? 0;
    let setting: CodexSetting = [...(ledger.settings[lane] ?? ["", "default"])];
    if (size < offset) {
      offset = 0; // rewritten from the start: what it holds again is counted once by its ids
      setting = ["", "default"];
    }
    let index = laneIndex.get(lane);
    if (index === undefined) {
      index = ledger.lanes.length;
      ledger.lanes.push(lane);
      laneIndex.set(lane, index);
    }
    try {
      for (const [line, next] of newLines(path, offset, size)) {
        offset = next;
        let spend: Spend | null = null;
        try {
          spend = source === "claude" ? claudeSpend(line) : codexSpend(line, setting);
        } catch {
          spend = null; // a line agent-pace does not understand costs nothing
        }
        if (spend === null) {
          continue;
        }
        const key = idKey(spend.id);
        const counted = ledger.seen[key];
        if (counted === undefined) {
          const minute = Math.floor(spend.t / 60) * 60;
          ledger.seen[key] = [minute, index, spend.dollars];
          add(minute, index, spend.dollars);
        } else if (spend.dollars > counted[2]) {
          add(counted[0], counted[1], spend.dollars - counted[2]); // a later line of it costs more
          counted[2] = spend.dollars;
        }
      }
    } catch (error) {
      if (!isSystemError(error)) {
        throw error;
      }
      // unreadable this time: the next reading tries again from where this one stopped
    }
    ledger.offsets[lane] = offset;
    if (source === "codex") {
      ledger.settings[lane] = setting;
    }
  }
  for (const lane of Object.keys(ledger.offsets)) {
    if (!files.has(join(root, lane))) {
      delete ledger.offsets[lane]; // gone, or untouched for longer than the ledger keeps
      delete ledger.settings[lane];
    }
  }
  for (const [key, [minute]] of Object.entries(ledger.seen)) {
    if (minute < horizon) {
      delete ledger.seen[key];
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
  // a request's lane always has its bucket, so the buckets and the files name every lane in use
  const used = new Set([...kept.map(([, lane]) => old[lane]), ...Object.keys(ledger.offsets)]);
  ledger.lanes = old.filter((lane) => used.has(lane));
  const index = new Map(ledger.lanes.map((lane, i) => [lane, i]));
  const renumber = (lane: number) => index.get(old[lane] ?? "");
  ledger.buckets = kept
    .flatMap(([minute, lane, dollars]): Bucket[] => {
      const now = renumber(lane);
      return now === undefined ? [] : [[minute, now, dollars]];
    })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [key, seen] of Object.entries(ledger.seen)) {
    const now = renumber(seen[1]);
    if (now === undefined) {
      delete ledger.seen[key];
    } else {
      seen[1] = now;
    }
  }
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

  /** The first bucket whose middle is after t. */
  private after(t: number): number {
    const minute = Math.floor((t - 30) / 60) * 60 + 60;
    let lo = 0;
    let hi = this.buckets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.buckets[mid] as Bucket)[0] < minute) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** Dollars all lanes spent in the minutes whose middle falls in (since, until]. */
  spent(since: number, until: number): number {
    return (this.prefix[this.after(until)] ?? 0) - (this.prefix[this.after(since)] ?? 0);
  }

  /** Each lane's dollars in (since, until] and the first minute it spent in them. */
  byLane(since: number, until: number): Map<string, { dollars: number; first: number }> {
    const out = new Map<string, { dollars: number; first: number }>();
    const to = this.after(until);
    for (let i = this.after(since); i < to; i++) {
      const [minute, lane, dollars] = this.buckets[i] as Bucket;
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
