// Timestamps are unix seconds as floats, as Python's time.time() gives them. ISO text keeps
// Python's microseconds and "+00:00", and local times use Python's "%a %-d %b %H:%M".

/** C's round(): half away from zero. */
function roundHalfAway(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** CPython's _PyTime_RoundHalfEven. */
function roundHalfEven(x: number): number {
  const rounded = roundHalfAway(x);
  return Math.abs(x - rounded) === 0.5 ? 2 * roundHalfAway(x / 2) : rounded;
}

/** Whole seconds and microseconds of a timestamp, rounded as datetime.fromtimestamp rounds. */
function splitTimestamp(t: number): { seconds: number; micros: number } {
  let seconds = Math.trunc(t);
  let micros = roundHalfEven((t - seconds) * 1e6);
  if (micros >= 1e6) {
    micros -= 1e6;
    seconds += 1;
  } else if (micros < 0) {
    micros += 1e6;
    seconds -= 1;
  }
  return { seconds, micros };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `datetime.fromtimestamp(t, timezone.utc).isoformat()`. */
export function isoUtc(t: number): string {
  const { seconds, micros } = splitTimestamp(t);
  const d = new Date(seconds * 1000);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${date}T${time}${micros ? `.${pad(micros, 6)}` : ""}+00:00`;
}

/** `iso(t)` in the Python version: None stays None. */
export function isoOrNull(t: number | null): string | null {
  return t === null ? null : isoUtc(t);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})|^(\d{4})(\d{2})(\d{2})/;
const ISO_TIME =
  /^(\d{2})(?:(:?)(\d{2})(?:\2(\d{2})(?:[.,](\d+))?)?)?(?:(Z)|([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,6}))?)?)?)?$/;

function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 ? (leap ? 29 : 28) : ([31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0);
}

function invalid(text: string): never {
  throw new RangeError(`Invalid isoformat string: '${text}'`);
}

/**
 * `datetime.fromisoformat(text).timestamp()` for the forms agent-pace meets: an extended or
 * basic date, optionally a time with a fraction and an offset. Naive times are local, as in
 * Python. Anything else is a RangeError, Python's ValueError.
 */
export function parseIso(text: string): number {
  const date = ISO_DATE.exec(text);
  if (!date) {
    invalid(text);
  }
  const year = Number(date[1] ?? date[4]);
  const month = Number(date[2] ?? date[5]);
  const day = Number(date[3] ?? date[6]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) {
    invalid(text);
  }
  const rest = text.slice(date[0].length);
  let hour = 0;
  let minute = 0;
  let second = 0;
  let micros = 0;
  let offsetSeconds: number | null = null;
  let offsetMicros = 0;
  if (rest !== "") {
    // Python takes any one character between the date and the time.
    const time = ISO_TIME.exec([...rest].slice(1).join(""));
    if (!time || [...rest].length < 2) {
      invalid(text);
    }
    hour = Number(time[1]);
    minute = Number(time[3] ?? 0);
    second = Number(time[4] ?? 0);
    micros = Number((time[5] ?? "").slice(0, 6).padEnd(6, "0"));
    if (hour > 23 || minute > 59 || second > 59) {
      invalid(text);
    }
    if (time[6]) {
      offsetSeconds = 0;
    } else if (time[7]) {
      const sign = time[7] === "-" ? -1 : 1;
      const hours = Number(time[8]);
      const minutes = Number(time[9] ?? 0);
      const seconds = Number(time[10] ?? 0);
      if (hours > 23 || minutes > 59 || seconds > 59) {
        invalid(text);
      }
      offsetSeconds = sign * (hours * 3600 + minutes * 60 + seconds);
      offsetMicros = sign * Number((time[11] ?? "").padEnd(6, "0") || 0);
    }
  }
  if (offsetSeconds === null) {
    const local = new Date(year, month - 1, day, hour, minute, second);
    local.setFullYear(year);
    return (local.getTime() * 1000 + micros) / 1e6;
  }
  const utc = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
  utc.setUTCFullYear(year); // Date.UTC reads years 0-99 as 1900-1999
  const utcSeconds = utc.getTime() / 1000 - offsetSeconds;
  return (utcSeconds * 1e6 + micros - offsetMicros) / 1e6;
}

function localParts(t: number, timeZone: string | undefined): Record<string, string> {
  const format = new Intl.DateTimeFormat("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(Math.floor(t * 1000)))) {
    parts[part.type] = part.value;
  }
  return parts;
}

/** `strftime("%a %-d %b %H:%M")` in local time, e.g. "Thu 22 Oct 21:59". */
export function localStamp(t: number, timeZone: string | undefined): string {
  const p = localParts(t, timeZone);
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/** `strftime("%H:%M")` in local time. */
export function localClock(t: number, timeZone: string | undefined): string {
  const p = localParts(t, timeZone);
  return `${p.hour}:${p.minute}`;
}
