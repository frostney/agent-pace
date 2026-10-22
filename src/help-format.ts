// Python's argparse.HelpFormatter and textwrap, for the help and usage text agent-pace's
// Python version printed. Only what agent-pace's options need: long options, one positional.

const WORD_SEPARATOR =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: textwrap's whitespace includes \v and \f
  /([\t\n\x0b\x0c\r ]+|(?<=[\w!"'&.,?])-{2,}(?=\w)|[^\t\n\x0b\x0c\r ]+?(?:-(?:(?<=[^\d\W]{2}-)|(?<=[^\d\W]-[^\d\W]-))(?=[^\d\W]-?[^\d\W])|(?=[\t\n\x0b\x0c\r ]|$)|(?<=[\w!"'&.,?])(?=-{2,}\w)))/;

const isBlank = (chunk: string) => chunk.trim() === "";

/** `textwrap.wrap(text, width)` with its defaults (break on hyphens, break long words). */
export function wrap(text: string, width: number, indent = ""): string[] {
  const chunks = text
    .split(WORD_SEPARATOR)
    .filter((c) => c !== "")
    .reverse();
  const lines: string[] = [];
  while (chunks.length > 0) {
    const line: string[] = [];
    let length = 0;
    const room = width - indent.length;
    if (isBlank(chunks.at(-1) ?? "") && lines.length > 0) {
      chunks.pop();
    }
    while (chunks.length > 0) {
      const next = chunks.at(-1) ?? "";
      if (length + next.length > room) {
        break;
      }
      line.push(next);
      length += next.length;
      chunks.pop();
    }
    const long = chunks.at(-1);
    if (long !== undefined && long.length > room) {
      const spaceLeft = room < 1 ? 1 : room - length;
      let end = spaceLeft;
      const hyphen = long.lastIndexOf("-", spaceLeft - 1);
      if (long.length > spaceLeft && hyphen > 0 && /[^-]/.test(long.slice(0, hyphen))) {
        end = hyphen + 1;
      }
      line.push(long.slice(0, end));
      chunks[chunks.length - 1] = long.slice(end);
    }
    if (line.length > 0 && isBlank(line.at(-1) ?? "")) {
      line.pop();
    }
    if (line.length > 0) {
      lines.push(indent + line.join(""));
    }
  }
  return lines;
}

/** argparse collapses the whitespace of help text before wrapping it. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface HelpAction {
  /** "-h, --help", "--target TARGET", or a positional's metavar. */
  readonly invocation: string;
  /** "[--target TARGET]" in the usage line. */
  readonly usage: string;
  readonly help: string | null;
}

export interface HelpLayout {
  readonly prog: string;
  readonly description: string;
  readonly epilog: string;
  readonly optionals: readonly HelpAction[];
  readonly positionals: readonly HelpAction[];
  /** The terminal's columns; argparse leaves two of them free. */
  readonly columns: number;
}

/** `ArgumentParser.format_usage()`. */
export function formatUsage(layout: HelpLayout): string {
  const width = layout.columns - 2;
  const prefix = "usage: ";
  const optionals = layout.optionals.map((a) => a.usage);
  const positionals = layout.positionals.map((a) => a.usage);
  const all = [layout.prog, ...optionals, ...positionals].join(" ");
  if (prefix.length + all.length <= width) {
    return `${prefix}${all}\n`;
  }
  const lines = (parts: readonly string[], indent: string, first?: string) => {
    const out: string[] = [];
    let line: string[] = [];
    let length = first === undefined ? indent.length - 1 : first.length - 1;
    for (const part of parts) {
      if (length + 1 + part.length > width && line.length > 0) {
        out.push(indent + line.join(" "));
        line = [];
        length = indent.length - 1;
      }
      line.push(part);
      length += part.length + 1;
    }
    if (line.length > 0) {
      out.push(indent + line.join(" "));
    }
    if (first !== undefined && out[0] !== undefined) {
      out[0] = out[0].slice(indent.length);
    }
    return out;
  };
  let usage: string[];
  if (prefix.length + layout.prog.length <= 0.75 * width) {
    const indent = " ".repeat(prefix.length + layout.prog.length + 1);
    if (optionals.length > 0) {
      usage = [...lines([layout.prog, ...optionals], indent, prefix), ...lines(positionals, indent)];
    } else if (positionals.length > 0) {
      usage = lines([layout.prog, ...positionals], indent, prefix);
    } else {
      usage = [layout.prog];
    }
  } else {
    const indent = " ".repeat(prefix.length);
    let wrapped = lines([...optionals, ...positionals], indent);
    if (wrapped.length > 1) {
      wrapped = [...lines(optionals, indent), ...lines(positionals, indent)];
    }
    usage = [layout.prog, ...wrapped];
  }
  return `${prefix}${usage.join("\n")}\n`;
}

/** `ArgumentParser.format_help()`. */
export function formatHelp(layout: HelpLayout): string {
  const width = layout.columns - 2;
  const maxHelpPosition = Math.min(24, Math.max(width - 20, 4));
  const actions = [...layout.positionals, ...layout.optionals];
  const longest = Math.max(0, ...actions.map((a) => a.invocation.length + 2));
  const helpPosition = Math.min(longest + 2, maxHelpPosition);
  const helpWidth = Math.max(width - helpPosition, 11);
  const actionWidth = helpPosition - 2 - 2;
  const action = (a: HelpAction) => {
    if (a.help === null) {
      return `  ${a.invocation}\n`;
    }
    const help = wrap(collapse(a.help), helpWidth);
    let out: string;
    let rest: string[];
    if (a.invocation.length <= actionWidth) {
      out = `  ${a.invocation.padEnd(actionWidth)}  ${help[0] ?? ""}\n`;
      rest = help.slice(1);
    } else {
      out = `  ${a.invocation}\n`;
      rest = help;
    }
    return out + rest.map((line) => `${" ".repeat(helpPosition)}${line}\n`).join("");
  };
  const fill = (text: string) => `${wrap(collapse(text), Math.max(width, 11)).join("\n")}\n\n`;
  const section = (heading: string, items: readonly HelpAction[]) =>
    items.length === 0 ? "" : `${heading}:\n${items.map(action).join("")}\n`;
  const help = [
    `${formatUsage(layout)}\n`,
    fill(layout.description),
    section("positional arguments", layout.positionals),
    section("options", layout.optionals),
    fill(layout.epilog),
  ].join("");
  return `${help.replace(/\n\n\n+/g, "\n\n").replace(/^\n+|\n+$/g, "")}\n`;
}
