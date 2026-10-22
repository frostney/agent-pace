import { Float, floatRepr, parseFloatText, parseIntText, stringRepr } from "./python-format.ts";

export { Float };

export function float(value: number): Float;
export function float(value: number | null): Float | null;
export function float(value: number | null): Float | null {
  return value === null ? null : new Float(value);
}

export type Json = null | boolean | string | number | Float | readonly Json[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: Json;
}

function stringJson(text: string): string {
  let out = '"';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const char = text[i] ?? "";
    if (char === '"') {
      out += '\\"';
    } else if (char === "\\") {
      out += "\\\\";
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else if (char === "\b") {
      out += "\\b";
    } else if (char === "\f") {
      out += "\\f";
    } else if (code < 0x20 || code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += char;
    }
  }
  return `${out}"`;
}

function floatJson(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? "Infinity" : "-Infinity";
  }
  return floatRepr(value);
}

/** Python's `json.dumps(value)`: ", " and ": " separators, non-ASCII escaped. */
export function dumps(value: Json): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return stringJson(value);
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : floatJson(value);
  }
  if (value instanceof Float) {
    return floatJson(value.value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: Json) => dumps(item)).join(", ")}]`;
  }
  const entries = Object.entries(value as JsonObject);
  return `{${entries.map(([key, item]) => `${stringJson(key)}: ${dumps(item)}`).join(", ")}}`;
}

/**
 * Python's `json.loads(text)` for a provider's response: a number written with a fraction or
 * an exponent stays a float (1.0 is a Float, 1 a number), as Python's isinstance checks see it.
 */
export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && Number.isInteger(value) && /[.eE]/.test(context?.source ?? "")
      ? new Float(value)
      : value,
  );
}

/** A JSON value decoded from untrusted input, before it is checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Float);
}

/**
 * Python's `value.get(key)`, which fails on anything but a dict; the Python version let that
 * failure end the reading, and so does this.
 */
export function get(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    throw new TypeError(`${pythonTypeName(value)} object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : null;
}

function pythonTypeName(value: unknown): string {
  if (value === null || value === undefined) {
    return "'NoneType'";
  }
  if (Array.isArray(value)) {
    return "'list'";
  }
  if (typeof value === "string") {
    return "'str'";
  }
  if (typeof value === "boolean") {
    return "'bool'";
  }
  if (value instanceof Float) {
    return "'float'";
  }
  return Number.isInteger(value) ? "'int'" : "'float'";
}

/** Python's `float(value)` for a value decoded from JSON. */
export function toFloat(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof Float) {
    return value.value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const parsed = parseFloatText(value);
    if (parsed === null) {
      throw new TypeError(`could not convert string to float: ${stringRepr(value)}`);
    }
    return parsed;
  }
  throw new TypeError("float() argument must be a string or a real number");
}

/** Python's `int(value)` for a value decoded from JSON: floats truncate toward zero. */
export function toInt(value: unknown): number {
  if (value instanceof Float) {
    return toInt(value.value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`cannot convert float ${floatRepr(value)} to integer`);
    }
    return Math.trunc(value) + 0;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "string") {
    const parsed = parseIntText(value);
    if (parsed === null) {
      throw new TypeError(`invalid literal for int() with base 10: ${stringRepr(value)}`);
    }
    return parsed;
  }
  throw new TypeError("int() argument must be a string or a real number");
}

/** A JSON number (int or float) or bool as Python compares it with `==`; null for anything else. */
export function numericValue(value: unknown): number | null {
  if (value instanceof Float) {
    return value.value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return typeof value === "number" ? value : null;
}

/** Whether Python's `isinstance(value, int)` holds for a JSON value (bool is an int there). */
export function isPythonInt(value: unknown): value is number | boolean {
  return typeof value === "boolean" || Number.isInteger(value);
}

/** Python's truthiness of a JSON value. */
export function truthy(value: unknown): boolean {
  if (value instanceof Float) {
    return value.value !== 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value !== null && typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
}

/** Python's `a or b`: a if it is truthy, else b (evaluated only then). */
export function or(value: unknown, otherwise: () => unknown): unknown {
  return truthy(value) ? value : otherwise();
}

/** Python iterating a JSON value: a list's items, a string's characters, a dict's keys. */
export function items(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return [...value];
  }
  if (isRecord(value)) {
    return Object.keys(value);
  }
  throw new TypeError("object is not iterable");
}
