import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What agent-pace takes from the machine it runs on; tests pass their own. */
export interface Host {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** The IANA zone for local times; undefined is the system's own. */
  readonly timeZone: string | undefined;
  /** Columns of the terminal stdout is on, if it is one (for --help). */
  readonly terminalColumns: number | undefined;
  /** Seconds for the whole `codex app-server` exchange. */
  readonly appServerTimeoutS: number;
  /** Unix time in seconds, as Python's time.time(). */
  now(): number;
  /** Seconds on a clock that only moves forward. */
  monotonic(): number;
  fetch(url: string, init: RequestInit): Promise<Response>;
  stdout(text: string): void;
  stderr(text: string): void;
  sleep(seconds: number): Promise<void>;
}

export function systemHost(): Host {
  return {
    env: process.env,
    platform: process.platform,
    timeZone: undefined,
    terminalColumns: process.stdout.isTTY ? process.stdout.columns : undefined,
    appServerTimeoutS: 20,
    now: () => Date.now() / 1000,
    monotonic: () => performance.now() / 1000,
    fetch: (url, init) => fetch(url, init),
    // Written at once, as Python's print with flush=True: a closed pipe is an error the
    // watch loop reports ("Broken pipe"), not output dropped while alerts go on.
    stdout: (text) => {
      writeSync(1, text);
    },
    stderr: (text) => {
      writeSync(2, text);
    },
    sleep: (seconds) => {
      if (!(seconds >= 0)) {
        throw new RangeError("sleep length must be non-negative"); // Python's time.sleep
      }
      return Bun.sleep(seconds * 1000);
    },
  };
}

/** Python's `os.path.expanduser("~")`. */
export function homeDirectory(env: Host["env"]): string {
  const home = env.HOME;
  if (home === undefined) {
    return homedir();
  }
  return home.replace(/\/+$/, "") || "/";
}

/** Python's `os.environ.get(name, fallback)`: a variable set to "" is "", not the fallback. */
function envOr(env: Host["env"], name: string, fallback: () => string): string {
  const value = env[name];
  return value === undefined ? fallback() : value;
}

export function claudeHome(env: Host["env"]): string {
  return envOr(env, "CLAUDE_CONFIG_DIR", () => join(homeDirectory(env), ".claude"));
}

export function codexHome(env: Host["env"]): string {
  return envOr(env, "CODEX_HOME", () => join(homeDirectory(env), ".codex"));
}

export function defaultStateDirectory(env: Host["env"]): string {
  const base = envOr(env, "XDG_STATE_HOME", () => join(homeDirectory(env), ".local", "state"));
  return join(base, "agent-pace");
}

/**
 * How to start `name` with `args` as Python's subprocess did: found on the host's PATH, run
 * under the name it was given, with the host's environment. Null if it is not on PATH.
 */
export function commandLine(
  name: string,
  args: readonly string[],
  host: Host,
): { cmd: string[]; options: { argv0: string; env: Record<string, string> } } | null {
  // with no PATH, Python searches os.defpath
  const path = Bun.which(name, { PATH: host.env.PATH ?? "/bin:/usr/bin" });
  if (path === null) {
    return null;
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { cmd: [path, ...args], options: { argv0: name, env } };
}
