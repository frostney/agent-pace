import type { PlanMode } from "./assess.ts";
import { formatHelp, formatUsage, type HelpAction, type HelpLayout } from "./help-format.ts";
import { parseFloatText, parseIntText, stringRepr } from "./python-format.ts";
import { SOURCES, type Source } from "./usage.ts";

export interface Options {
  readonly source: Source | "plan";
  readonly watch: boolean;
  readonly alertsOnly: boolean;
  readonly json: boolean;
  readonly target: number;
  readonly band: number;
  readonly interval: number;
  readonly plan: PlanMode;
  readonly reserve: number;
  readonly redeemMargin: number;
  readonly laneHours: number;
  readonly state: string;
  readonly notify: string | null;
}

type Dest = Exclude<keyof Options, "source">;

/** An option and the type of value it takes, which fixes the fields it may set. */
type OptionSpec = { readonly flag: string; readonly metavar?: string; readonly help?: string } & (
  | { readonly kind: "flag"; readonly dest: "watch" | "alertsOnly" | "json" }
  | { readonly kind: "float"; readonly dest: "target" | "band" | "reserve" | "redeemMargin" | "laneHours" }
  | { readonly kind: "int"; readonly dest: "interval" }
  | { readonly kind: "string"; readonly dest: "state" | "notify" }
  | { readonly kind: "choice"; readonly dest: "plan"; readonly choices: readonly PlanMode[] }
);

const OPTIONS: readonly OptionSpec[] = [
  { flag: "--watch", dest: "watch", kind: "flag" },
  { flag: "--alerts-only", dest: "alertsOnly", kind: "flag" },
  { flag: "--json", dest: "json", kind: "flag" },
  { flag: "--target", dest: "target", kind: "float", metavar: "TARGET" },
  { flag: "--band", dest: "band", kind: "float", metavar: "BAND" },
  { flag: "--interval", dest: "interval", kind: "int", metavar: "INTERVAL" },
  { flag: "--plan", dest: "plan", kind: "choice", choices: ["fill", "even"] },
  {
    flag: "--reserve",
    dest: "reserve",
    kind: "float",
    metavar: "RESERVE",
    help: "with --plan fill, pace like --plan even once the long window has this many points left",
  },
  {
    flag: "--redeem-margin",
    dest: "redeemMargin",
    kind: "float",
    metavar: "HOURS",
    help:
      "aim to fill a window to 100% this many hours before a banked reset expires; at the limit, keep a banked reset " +
      "(nothing expires first) if the window resets on its own within this many hours",
  },
  {
    flag: "--lane-hours",
    dest: "laneHours",
    kind: "float",
    metavar: "HOURS",
    help: "give each new lane this many hours before the next reading when counting lane headroom (default 1)",
  },
  { flag: "--state", dest: "state", kind: "string", metavar: "STATE" },
  {
    flag: "--notify",
    dest: "notify",
    kind: "string",
    metavar: "CMD",
    help: "run CMD with the alert text as its last argument on each alert or reset",
  },
];

const SOURCE_CHOICES = [...SOURCES, "plan"] as const;

const DESCRIPTION =
  "Pace agent work against Claude Code and Codex usage windows, " +
  "including banked resets, and say how many more agent lanes the headroom supports. `plan` reads both once " +
  "and recommends where spare work should go. It never redeems a reset.";

const EPILOG =
  "Lane headroom: per-lane burn is a window's recent burn over the lanes active meanwhile, " +
  "time-weighted (each count covers the 10 minutes before it). Usage comes in whole points, so a " +
  "rate needs to be known to within a third: two steps up timed by the readings around them, use " +
  "moving 3 points, or a stretch of a fifth of the window, which bounds the burn by one point more " +
  'than it moved. Until then it says "measuring"; a short window\'s status uses the same rate. A window that cannot be ' +
  'measured does not hold the source at "measuring" if, after its first hour, even twice its ' +
  "average burn would end it at or below its aim. A new lane is counted for --lane-hours, then read again; the " +
  "lanes already running are taken to go on until the window resets, or with a reset banked (running out early " +
  "is fine, then redeem it) only until the next reading. A week is paced by the lanes running now when their " +
  "burn is known, by its window average otherwise.";

function metavar(spec: OptionSpec): string {
  return spec.kind === "choice" ? `{${spec.choices.join(",")}}` : (spec.metavar ?? "");
}

type Lookup =
  | { readonly kind: "positional" }
  | { readonly kind: "unknown" }
  | { readonly kind: "ambiguous"; readonly matches: string[] }
  | { readonly kind: "help"; readonly explicit: string | null }
  | { readonly kind: "option"; readonly spec: OptionSpec; readonly explicit: string | null };

/** The size of the matching blocks difflib.SequenceMatcher finds between a and b. */
function matchingSize(a: string, b: string): number {
  let best = { i: 0, j: 0, k: 0 };
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) {
        k++;
      }
      if (k > best.k) {
        best = { i, j, k };
      }
    }
  }
  if (best.k === 0) {
    return 0;
  }
  const before = matchingSize(a.slice(0, best.i), b.slice(0, best.j));
  const after = matchingSize(a.slice(best.i + best.k), b.slice(best.j + best.k));
  return before + best.k + after;
}

/** `difflib.get_close_matches(word, choices, 1)`: the closest choice at a ratio of 0.6 or more. */
function closestChoice(word: string, choices: readonly string[]): string | null {
  let best: { score: number; choice: string } | null = null;
  for (const choice of choices) {
    const score = (2 * matchingSize(choice, word)) / (choice.length + word.length);
    if (
      score >= 0.6 &&
      (best === null || score > best.score || (score === best.score && choice > best.choice))
    ) {
      best = { score, choice };
    }
  }
  return best?.choice ?? null;
}

/** argparse's message for a value that is not one of the choices (Python 3.15 suggests one). */
function invalidChoice(value: string, choices: readonly string[]): string {
  const listed = choices.map((c) => stringRepr(c)).join(", ");
  const closest = closestChoice(value, choices);
  const suggestion = closest === null ? "" : `, maybe you meant ${stringRepr(closest)}?`;
  return `invalid choice: ${stringRepr(value)}${suggestion} (choose from ${listed})`;
}

export type Parsed =
  | { readonly kind: "options"; readonly options: Options }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

export class ArgumentParser {
  constructor(
    private readonly prog: string,
    /** The source the command name implies (claude-pace, codex-pace); null takes it as an argument. */
    private readonly implied: Source | null,
    private readonly columns: number,
  ) {}

  private layout(): HelpLayout {
    const optionals: HelpAction[] = [
      { invocation: "-h, --help", usage: "[-h]", help: "show this help message and exit" },
      ...OPTIONS.map((spec) => {
        const value = spec.kind === "flag" ? "" : ` ${metavar(spec)}`;
        return { invocation: spec.flag + value, usage: `[${spec.flag}${value}]`, help: spec.help ?? null };
      }),
    ];
    const choices = `{${SOURCE_CHOICES.join(",")}}`;
    const positionals = this.implied ? [] : [{ invocation: choices, usage: choices, help: null }];
    return {
      prog: this.prog,
      description: DESCRIPTION,
      epilog: EPILOG,
      optionals,
      positionals,
      columns: this.columns,
    };
  }

  /** `parser.error(message)`: the usage line, then the message, for stderr (status 2). */
  error(message: string): string {
    return `${formatUsage(this.layout())}${this.prog}: error: ${message}\n`;
  }

  parse(argv: readonly string[], defaultState: string): Parsed {
    const values: { -readonly [K in Dest]: Options[K] } = {
      watch: false,
      alertsOnly: false,
      json: false,
      target: 97,
      band: 7,
      interval: 300,
      plan: "fill",
      reserve: 10,
      redeemMargin: 2,
      laneHours: 1,
      state: defaultState,
      notify: null,
    };
    let source: Source | "plan" | null = this.implied;
    const extras: string[] = [];
    const fail = (message: string): Parsed => ({ kind: "error", text: this.error(message) });

    // argparse sorts every word into an option ("O"), a value ("A") or the first "--" ("-")
    // before it takes any of them; everything after "--" is a value
    const pattern: ("O" | "A" | "-")[] = [];
    const found = new Map<number, Exclude<Lookup, { kind: "positional" | "ambiguous" }>>();
    for (const [i, arg] of argv.entries()) {
      if (pattern.includes("-")) {
        pattern.push("A");
      } else if (arg === "--") {
        pattern.push("-");
      } else {
        const what = this.lookup(arg);
        if (what.kind === "ambiguous") {
          return fail(`ambiguous option: ${arg} could match ${what.matches.join(", ")}`);
        }
        if (what.kind === "positional") {
          pattern.push("A");
        } else {
          pattern.push("O");
          found.set(i, what);
        }
      }
    }

    /** The positional source, matched as argparse matches "-*A-*"; the index after it. */
    const takePositional = (start: number): number | Parsed => {
      if (source !== null) {
        return start;
      }
      let end = start;
      while (pattern[end] === "-") {
        end++;
      }
      if (pattern[end] !== "A") {
        return start;
      }
      end++;
      while (pattern[end] === "-") {
        end++;
      }
      const words = argv.slice(start, end);
      if (pattern.slice(start, end).includes("-")) {
        words.splice(words.indexOf("--"), 1); // the first "--" only
      }
      const taken = this.takeSource(words[0] ?? "");
      if (taken.kind === "error") {
        return fail(taken.message);
      }
      source = taken.source;
      return end;
    };

    /** Converts and stores an option's value; the error, or null. */
    const take = (spec: Exclude<OptionSpec, { kind: "flag" }>, value: string): string | null => {
      switch (spec.kind) {
        case "float": {
          const parsed = parseFloatText(value);
          if (parsed === null) {
            return `argument ${spec.flag}: invalid float value: ${stringRepr(value)}`;
          }
          if (spec.dest === "laneHours" && !(parsed > 0)) {
            return `argument ${spec.flag}: must be more than 0: ${stringRepr(value)}`;
          }
          values[spec.dest] = parsed;
          return null;
        }
        case "int": {
          const parsed = parseIntText(value);
          if (parsed === null) {
            return `argument ${spec.flag}: invalid int value: ${stringRepr(value)}`;
          }
          values[spec.dest] = parsed;
          return null;
        }
        case "string":
          values[spec.dest] = value;
          return null;
        case "choice": {
          const choice = spec.choices.find((c) => c === value);
          if (choice === undefined) {
            return `argument ${spec.flag}: ${invalidChoice(value, spec.choices)}`;
          }
          values[spec.dest] = choice;
          return null;
        }
      }
    };

    /** One option and its value; the index after them. */
    const takeOption = (start: number): number | Parsed => {
      const option = found.get(start);
      if (option === undefined || option.kind === "unknown") {
        extras.push(argv[start] as string);
        return start + 1;
      }
      if (option.kind === "help") {
        if (option.explicit !== null) {
          return fail(`argument -h/--help: ignored explicit argument ${stringRepr(option.explicit)}`);
        }
        return { kind: "help", text: formatHelp(this.layout()) };
      }
      const spec = option.spec;
      if (spec.kind === "flag") {
        if (option.explicit !== null) {
          return fail(`argument ${spec.flag}: ignored explicit argument ${stringRepr(option.explicit)}`);
        }
        values[spec.dest] = true;
        return start + 1;
      }
      let value = option.explicit;
      let next = start + 1;
      if (value === null) {
        if (pattern[start + 1] !== "A") {
          return fail(`argument ${spec.flag}: expected one argument`);
        }
        value = argv[start + 1] as string;
        next = start + 2;
      }
      const problem = take(spec, value);
      return problem === null ? next : fail(problem);
    };

    const lastOption = Math.max(-1, ...found.keys());
    let start = 0;
    while (start <= lastOption) {
      let nextOption = start;
      while (nextOption <= lastOption && !found.has(nextOption)) {
        nextOption++;
      }
      if (start !== nextOption) {
        const end = takePositional(start);
        if (typeof end !== "number") {
          return end;
        }
        const advanced = end > start;
        start = end;
        if (advanced) {
          continue;
        }
      }
      if (!found.has(start)) {
        extras.push(...argv.slice(start, nextOption));
        start = nextOption;
      }
      const end = takeOption(start);
      if (typeof end !== "number") {
        return end;
      }
      start = end;
    }
    const stop = takePositional(start);
    if (typeof stop !== "number") {
      return stop;
    }
    extras.push(...argv.slice(stop));
    if (source === null) {
      return fail("the following arguments are required: source");
    }
    if (extras.length > 0) {
      return fail(`unrecognized arguments: ${extras.join(" ")}`);
    }
    return { kind: "options", options: { source, ...values } };
  }

  private takeSource(
    arg: string,
  ): { kind: "source"; source: Source | "plan" } | { kind: "error"; message: string } {
    const choice = SOURCE_CHOICES.find((c) => c === arg);
    if (choice === undefined) {
      return { kind: "error", message: `argument source: ${invalidChoice(arg, SOURCE_CHOICES)}` };
    }
    return { kind: "source", source: choice };
  }

  /** argparse's `_parse_optional`: what one command-line word is. */
  private lookup(arg: string): Lookup {
    if (!arg.startsWith("-") || arg === "-") {
      return { kind: "positional" };
    }
    const flags = ["-h", "--help", ...OPTIONS.map((o) => o.flag)];
    const resolve = (flag: string, explicit: string | null) => {
      if (flag === "-h" || flag === "--help") {
        return { kind: "help" as const, explicit };
      }
      const spec = OPTIONS.find((o) => o.flag === flag) as OptionSpec;
      return { kind: "option" as const, spec, explicit };
    };
    if (flags.includes(arg)) {
      return resolve(arg, null);
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const explicit = eq >= 0 ? arg.slice(eq + 1) : null;
    if (eq >= 0 && flags.includes(name)) {
      return resolve(name, explicit);
    }
    if (arg.startsWith("--")) {
      const matches = flags.filter((f) => f.startsWith("--") && f.startsWith(name));
      if (matches.length > 1) {
        return { kind: "ambiguous", matches };
      }
      if (matches.length === 1) {
        return resolve(matches[0] as string, explicit);
      }
    }
    if (!arg.startsWith("--") && arg.startsWith("-h") && arg.length > 2) {
      return resolve("-h", null); // "-hq": -h, then flags that never run
    }
    if (/^-\d+$|^-\d*\.\d+$/.test(arg) || arg.includes(" ")) {
      return { kind: "positional" };
    }
    return { kind: "unknown" };
  }
}
