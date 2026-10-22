import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { floatRepr, parseFloatText } from "./python-format.ts";
import type { Source, UsageWindow } from "./usage.ts";

// The history files are CSV as Python's csv module wrote them ("\r\n" line ends, floats in
// repr), so the history a Python version kept carries over.

/** A history row: [observed at, used, resets at]. */
export type HistoryRow = readonly [number, number, number];

/** Reset times drift between readings; two within this many seconds are the same window. */
export const RESET_JITTER_S = 300;

export function logPath(state: string, source: Source, name: string): string {
  return join(state, `${source}-${name}.csv`);
}

/** CSV records as Python's csv.reader reads a text file: quoted fields, any line ending. */
function csvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  const normalized = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (quoted) {
      if (char === '"' && normalized[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
      started = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
      started = true;
    } else if (char === "\n") {
      if (started || field !== "") {
        record.push(field);
      }
      records.push(record);
      record = [];
      field = "";
      started = false;
    } else {
      field += char;
      started = true;
    }
  }
  if (started || field !== "") {
    record.push(field);
    records.push(record);
  }
  return records;
}

/**
 * The rows of a history file, each with at least three numeric fields. A missing file is no
 * rows; a field that is not a number ends the read there, as it did in Python.
 */
export function read(path: string): HistoryRow[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: HistoryRow[] = [];
  for (const record of csvRecords(text)) {
    if (record.length < 3) {
      continue;
    }
    const values = record.slice(0, 3).map(parseFloatText);
    const [t, used, resets] = values;
    if (t == null || used == null || resets == null) {
      break;
    }
    out.push([t, used, resets]);
  }
  return out;
}

export function csvLine(fields: readonly (string | number)[]): string {
  return `${fields.join(",")}\r\n`;
}

export function record(state: string, source: Source, w: UsageWindow, minGap = 0): void {
  const path = logPath(state, source, w.name);
  mkdirSync(state, { recursive: true });
  const last = read(path).at(-1);
  if (last && last[0] >= w.observedAt) {
    return; // no newer reading (e.g. a stale Codex snapshot)
  }
  if (last && w.observedAt - last[0] < minGap && Math.abs(last[2] - w.resetsAt) < RESET_JITTER_S) {
    return; // the same window read again within minGap: nothing new for the history
  }
  appendFileSync(path, csvLine([Math.trunc(w.observedAt), floatRepr(w.used), Math.trunc(w.resetsAt)]));
}
