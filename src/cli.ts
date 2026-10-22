import { basename } from "node:path";
import { ArgumentParser, type Options } from "./arguments.ts";
import { assess, laneSummary } from "./assess.ts";
import { ExitError, OsError, RateLimited, survivableErrorText } from "./errors.ts";
import { commandLine, defaultStateDirectory, type Host, systemHost } from "./host.ts";
import { runPlan } from "./plan.ts";
import { parseIntText, stringRepr } from "./python-format.ts";
import { dumps } from "./python-json.ts";
import { readSource } from "./readings.ts";
import { noteLines, render, rollovers, sourceJson, Wording } from "./report.ts";
import { shellWords } from "./shell-words.ts";
import type { Source } from "./usage.ts";

/** Runs CMD with the alert text as its last argument, as Python's subprocess.run did. */
function notify(command: string, text: string, host: Host): void {
  const words = shellWords(command);
  // with no words, Python ran the alert text itself as the command
  const [name, ...args] = words.length > 0 ? [...words, text] : [text];
  const line = name === undefined ? null : commandLine(name, args, host);
  if (line === null) {
    throw new OsError(`[Errno 2] No such file or directory: ${stringRepr(name ?? "")}`);
  }
  const result = Bun.spawnSync(line.cmd, {
    ...line.options,
    stdio: ["inherit", "inherit", "inherit"],
    timeout: 30_000,
  });
  if (result.exitedDueToTimeout) {
    throw new Error(`Command '${command}' timed out after 30 seconds`);
  }
}

async function pace(source: Source, options: Options, host: Host): Promise<number> {
  const seen = new Set<string>();
  const words = new Wording(host.timeZone);
  let first = true;
  for (;;) {
    try {
      const reading = await readSource(source, options.state, host);
      const now = host.now();
      const res = assess(source, reading.windows, options, reading.banked, reading.lanes, now);
      let messages = rollovers(source, res, seen);
      if (first) {
        messages = []; // only announce resets that happen while watching
      }
      first = false;
      if (options.json) {
        host.stdout(`${dumps({ source, ...sourceJson(reading, res) })}\n`);
      } else {
        // banked resets that need acting on (redeem now, or redeem anyway) alert too
        const due = res.some(
          (x) => x.banked && (x.banked.action === "redeem" || x.banked.action === "redeem-anyway"),
        );
        // "room left" is no nudge to add work when there is no room for another lane
        const lead = res[0];
        const alert =
          lead?.status === "over" || (lead?.status === "under" && laneSummary(res)[0] !== 0) || due;
        const extra = noteLines(source, res, reading, words);
        const line = render(source, res, host.now(), host.timeZone);
        const lines = [...messages, ...(!options.alertsOnly || alert ? [line, ...extra] : [])];
        host.stdout(lines.map((l) => `${l}\n`).join(""));
        // alerts follow the shortest window, the one agents are paced by; longer ones ride along in the line
        if (options.notify && (messages.length > 0 || alert)) {
          notify(options.notify, [...messages, line, ...extra].join(" "), host);
        }
      }
    } catch (error) {
      if (error instanceof RateLimited) {
        const retry = error.retryAfter && /^\d+$/.test(error.retryAfter) ? Number(error.retryAfter) : 600;
        const wait = Math.max(options.interval, retry);
        host.stderr(`agent-pace: ${error.message}; next try in ${Math.floor(wait / 60)} min\n`);
        if (!options.watch) {
          throw new ExitError(3);
        }
        await host.sleep(wait);
        continue;
      }
      const text = survivableErrorText(error);
      if (text === null) {
        throw error;
      }
      host.stderr(`agent-pace: ${text}\n`);
    }
    if (!options.watch) {
      return 0;
    }
    await host.sleep(options.interval);
  }
}

function terminalColumns(host: Host): number {
  const fromEnv = parseIntText(host.env.COLUMNS ?? "");
  if (fromEnv !== null && fromEnv > 0) {
    return fromEnv;
  }
  return host.terminalColumns || 80;
}

/**
 * agent-pace with these arguments, run as `prog`: a name starting with claude or codex picks
 * the source. Returns the exit status.
 */
export async function main(argv: readonly string[], prog: string, host: Host): Promise<number> {
  const implied: Source | null = prog.startsWith("claude")
    ? "claude"
    : prog.startsWith("codex")
      ? "codex"
      : null;
  const parser = new ArgumentParser(prog, implied, terminalColumns(host));
  const parsed = parser.parse(argv, defaultStateDirectory(host.env));
  if (parsed.kind === "help") {
    host.stdout(parsed.text);
    return 0;
  }
  if (parsed.kind === "error") {
    host.stderr(parsed.text);
    return 2;
  }
  const options = parsed.options;
  try {
    if (options.source === "plan") {
      if (options.watch || options.alertsOnly || options.notify) {
        host.stderr(
          parser.error(
            "plan reads both sources once and prints its recommendation; --watch, --alerts-only and --notify do not apply",
          ),
        );
        return 2;
      }
      await runPlan(options, host);
      return 0;
    }
    return await pace(options.source, options, host);
  } catch (error) {
    if (error instanceof ExitError) {
      if (error.message) {
        host.stderr(`${error.message}\n`);
      }
      return error.status;
    }
    throw error;
  }
}

/**
 * The name agent-pace was run as. A compiled binary sees the name it was called by (a link
 * named claude-pace); a script sees its own file, so each name has its own entry file.
 */
export function invokedName(): string {
  const compiled = Bun.main.startsWith("/$bunfs/");
  return basename(compiled ? process.argv0 : Bun.main).replace(/\.ts$/, "");
}

export async function run(): Promise<void> {
  process.exitCode = await main(process.argv.slice(2), invokedName(), systemHost());
}
