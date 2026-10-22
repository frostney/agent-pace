// agent-pace began as a Python script, and its text, JSON and history files are still read by
// people and tools that saw Python's output. These reproduce Python's number formatting and
// parsing exactly, so a reading prints digit for digit what the Python version printed.

/** |x| as mantissa * 2^exponent, exactly. */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(x));
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (biased === 0) {
    return { mantissa: fraction, exponent: -1074 };
  }
  return { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

/**
 * Python's `format(x, ".Nf")`: the exact binary value rounded half to even, so 2.5 is "2" and
 * 0.125 is "0.12", where `toFixed` rounds half up.
 */
export function formatFixed(x: number, places: number): string {
  if (Number.isNaN(x)) {
    return "nan";
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? "inf" : "-inf";
  }
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const { mantissa, exponent } = decompose(x);
  let digits: bigint;
  let scale: number;
  if (exponent >= 0) {
    digits = mantissa << BigInt(exponent);
    scale = 0;
  } else {
    digits = mantissa * 5n ** BigInt(-exponent);
    scale = -exponent;
  }
  if (scale > places) {
    const unit = 10n ** BigInt(scale - places);
    let quotient = digits / unit;
    const remainder = digits % unit;
    const half = unit / 2n;
    if (remainder > half || (remainder === half && quotient % 2n === 1n)) {
      quotient += 1n;
    }
    digits = quotient;
  } else {
    digits *= 10n ** BigInt(places - scale);
  }
  const text = digits.toString().padStart(places + 1, "0");
  const whole = text.slice(0, text.length - places);
  return places > 0 ? `${sign}${whole}.${text.slice(text.length - places)}` : `${sign}${whole}`;
}

/** Python's `round(x, places)` on a float: a float again. */
export function roundTo(x: number, places: number): number {
  if (!Number.isFinite(x)) {
    return x;
  }
  return Number(formatFixed(x, places));
}

/** Python's `round(x)` on a float: an int, half to even. */
export function roundToInt(x: number): number {
  if (!Number.isFinite(x)) {
    throw new RangeError(`cannot convert float ${floatRepr(x)} to integer`);
  }
  return Number(formatFixed(x, 0)) + 0;
}

/** Python's `repr(x)` of a float: the shortest digits that round-trip, "97.0" rather than "97". */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) {
    return "nan";
  }
  if (!Number.isFinite(x)) {
    return x > 0 ? "inf" : "-inf";
  }
  if (x === 0) {
    return Object.is(x, -0) ? "-0.0" : "0.0";
  }
  const sign = x < 0 ? "-" : "";
  // Number#toString picks the shortest digits closest to x, as Python's repr does; only the
  // layout around those digits differs.
  const [mantissaText = "", exponentText = "0"] = String(Math.abs(x)).split("e");
  const [wholeText = "", fractionText = ""] = mantissaText.split(".");
  const all = wholeText + fractionText;
  const leading = all.length - all.replace(/^0+/, "").length;
  const digits = all.slice(leading).replace(/0+$/, "") || "0";
  const exponent = wholeText.length - 1 + Number(exponentText) - leading;
  if (exponent < -4 || exponent >= 16) {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const magnitude = String(Math.abs(exponent)).padStart(2, "0");
    return `${sign}${mantissa}e${exponent < 0 ? "-" : "+"}${magnitude}`;
  }
  if (exponent < 0) {
    return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  }
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
  return `${sign}${whole}.${digits.slice(exponent + 1) || "0"}`;
}

/** A number that Python held as a float, so it prints as one ("97.0", not "97"). */
export class Float {
  constructor(readonly value: number) {}
}

/** An int or a Float as Python printed it. */
export function numberText(n: number | Float): string {
  return n instanceof Float ? floatRepr(n.value) : String(n);
}

const FLOAT_TEXT = /^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const SPECIAL_FLOAT = /^([+-]?)(inf|infinity|nan)$/i;
const INT_TEXT = /^[+-]?\d(?:_?\d)*$/;

/** Python's `float(text)`; null where Python raises ValueError. */
export function parseFloatText(text: string): number | null {
  const trimmed = text.trim();
  const special = SPECIAL_FLOAT.exec(trimmed);
  if (special) {
    if (special[2]?.toLowerCase() === "nan") {
      return Number.NaN;
    }
    return special[1] === "-" ? -Infinity : Infinity;
  }
  return FLOAT_TEXT.test(trimmed) ? Number(trimmed.replaceAll("_", "")) : null;
}

/** Python's `int(text)` in base 10; null where Python raises ValueError. */
export function parseIntText(text: string): number | null {
  const trimmed = text.trim();
  return INT_TEXT.test(trimmed) ? Number(trimmed.replaceAll("_", "")) : null;
}

/** Python's `float // float`, which floors the exact quotient rather than the rounded one. */
export function floorDivide(x: number, y: number): number {
  let remainder = x % y;
  let quotient = (x - remainder) / y;
  if (remainder) {
    if (y < 0 !== remainder < 0) {
      remainder += y;
      quotient -= 1;
    }
  }
  if (quotient) {
    let floored = Math.floor(quotient);
    if (quotient - floored > 0.5) {
      floored += 1;
    }
    return floored;
  }
  return Math.sign(x / y) < 0 || Object.is(x / y, -0) ? -0 : 0;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the line boundaries of Python's str.splitlines
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python's `str.splitlines()`: every line boundary Python knows, no trailing empty line. */
export function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** Python's `repr(text)` for the strings argparse quotes in its errors. */
export function stringRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || char === quote) {
      out += `\\${char}`;
    } else if (char === "\n") {
      out += "\\n";
    } else if (char === "\r") {
      out += "\\r";
    } else if (char === "\t") {
      out += "\\t";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += char;
    }
  }
  return `${quote}${out}${quote}`;
}
