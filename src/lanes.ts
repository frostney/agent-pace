import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { isSystemError } from "./errors.ts";
import { withLock } from "./file-lock.ts";
import { csvLine, read } from "./history.ts";
import { claudeHome, codexHome, type Host } from "./host.ts";
import { splitLines } from "./python-format.ts";
import { isRecord } from "./python-json.ts";
import { parseIso } from "./time-format.ts";
import type { LaneReading, Source } from "./usage.ts";

/** A lane is active if it did something in the last 10 minutes. */
export const LANE_IDLE_S = 600;
const TAIL_BYTES = 262144;

/**
 * Files under root ending in suffix that were written in the last LANE_IDLE_S seconds (mtime
 * only, no reads), walked as Python's os.walk walks: linked directories are not entered.
 */
function recentFiles(root: string, suffix: string, now: number): string[] {
  const out: string[] = [];
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
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (statSync(path).isDirectory()) {
            continue; // a linked directory: listed, not entered
          }
        } catch {
          // a dangling link is a file whose mtime cannot be read
        }
      }
      if (!entry.name.endsWith(suffix)) {
        continue;
      }
      try {
        if (Math.abs(now - statSync(path).mtimeMs / 1000) <= LANE_IDLE_S) {
          out.push(path);
        }
      } catch {
        // gone mid-scan
      }
    }
  };
  walk(root);
  return out;
}

function tail(path: string): { text: string; start: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) {
        break;
      }
      read += n;
    }
    return { text: buffer.subarray(0, read).toString("utf8"), start };
  } finally {
    closeSync(fd);
  }
}

/** Whether the last assistant message in a Claude Code session or subagent file is recent (reads only its tail). */
export function claudeLaneActive(path: string, now: number): boolean {
  let text: string;
  let start: number;
  try {
    ({ text, start } = tail(path));
  } catch {
    return false;
  }
  const lines = splitLines(text);
  if (start && lines.length <= 1) {
    return true; // one line longer than the tail: the file's recent mtime stands
  }
  for (const line of lines.reverse()) {
    if (!line.includes('"type":"assistant"')) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // the tail may start mid-line
    }
    if (isRecord(event) && event.type === "assistant") {
      const timestamp = event.timestamp;
      if (typeof timestamp !== "string") {
        return true; // no timestamp: the file's recent mtime stands
      }
      try {
        return Math.abs(now - parseIso(timestamp.replaceAll("Z", "+00:00"))) <= LANE_IDLE_S;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/**
 * How many agent lanes are working: Claude Code session and subagent files with assistant
 * activity in the last 10 minutes; Codex rollout files written in the last 10 minutes.
 */
export function activeLanes(source: Source, now: number, env: Host["env"]): number {
  if (source === "claude") {
    const files = recentFiles(join(claudeHome(env), "projects"), ".jsonl", now);
    return files.filter((path) => claudeLaneActive(path, now)).length;
  }
  const files = recentFiles(join(codexHome(env), "sessions"), ".jsonl", now);
  return files.filter((path) => basename(path).startsWith("rollout-")).length;
}

function laneRows(path: string): [number, number][] {
  return read(path).map(([t, count]) => [t, Math.trunc(count)]);
}

/** The lanes active now and the counts seen at earlier readings (the history of how many shared the burn). */
export async function laneReading(state: string, source: Source, host: Host): Promise<LaneReading> {
  const now = host.now();
  const active = activeLanes(source, now, host.env);
  const path = join(state, `lanes-${source}.csv`);
  let rows: [number, number][];
  try {
    mkdirSync(state, { recursive: true });
    // one sample a minute however many watchers run
    rows = await withLock(join(state, `.lanes-${source}.lock`), () => {
      const seen = laneRows(path);
      const last = seen.at(-1);
      if (last === undefined || now - last[0] >= 60) {
        if (seen.length >= 4000) {
          // keep the last 2000 samples, written whole so a reader never sees half a file
          const kept = seen.slice(-1999).map(([t, c]) => csvLine([Math.trunc(t), c, 0]));
          writeFileSync(`${path}.tmp`, kept.join("") + csvLine([Math.trunc(now), active, 0]));
          renameSync(`${path}.tmp`, path);
        } else {
          appendFileSync(path, csvLine([Math.trunc(now), active, 0]));
        }
      }
      return seen;
    });
  } catch (error) {
    if (!isSystemError(error)) {
      throw error;
    }
    rows = laneRows(path);
  }
  return { active, rows, at: now };
}
