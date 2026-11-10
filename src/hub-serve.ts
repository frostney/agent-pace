// `agent-pace hub serve`: the accounts' usage, read on the CLIProxyAPI hub itself.
//
// CLIProxyAPI holds every account's login. Its management API lists them (auth-files) and makes
// an upstream request with one of them (api-call, which puts the account's token where a header
// says $TOKEN$). That can send any account's token to any address, so the management key never
// leaves the hub: this service runs beside CLIProxyAPI, listens on 127.0.0.1 only, and answers
// clients that send the hub's access key, the key their Claude Code and Codex already send. It
// only reads: one GET per account to the usage endpoint each provider's own client reads (and
// for Codex, its list of banked resets), cached for a minute, and an account that answered 429
// is left alone as long as it asked. It answers with each account's windows and banked resets
// and never with a token, an email address or an upstream body.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_CLI_FALLBACK,
  claudeBanked,
  claudeCliVersion,
  claudeUsageHeaders,
  claudeWindows,
  USAGE_URL,
} from "./claude.ts";
import { CODEX_RESET_CREDITS_URL, CODEX_USAGE_URL, codexResetCredits, codexUsageWindows } from "./codex.ts";
import { defaultStateDirectory, type Host, homeDirectory } from "./host.ts";
import { HUB_ANSWER_VERSION, HUB_HEADER, HUB_HELLO } from "./hub.ts";
import { numberText, parseIntText } from "./python-format.ts";
import {
  dumps,
  float,
  get,
  isPythonInt,
  isRecord,
  type Json,
  type JsonObject,
  parseJson,
} from "./python-json.ts";
import { type Banked, SOURCES, type Source, type UsageWindow } from "./usage.ts";

/** Where the service listens on 127.0.0.1, next to CLIProxyAPI's 8317. */
export const HUB_PORT = 8318;
/** How long one read of a provider's accounts is answered from memory. */
export const HUB_CACHE_S = 60;

export interface HubServeOptions {
  readonly port: number;
  /** The directory with the hub's `access-key` and `management-key` files, one key in each. */
  readonly keys: string;
  /** CLIProxyAPI on this machine. */
  readonly cliproxy: string;
  /** Where the Claude Code version it claims is remembered. */
  readonly state: string;
}

/** A failure the service answers with a status and a message (never a secret). */
class HubFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function keyFile(options: HubServeOptions, name: "access-key" | "management-key"): string {
  const path = join(options.keys, name);
  let key: string;
  try {
    key = readFileSync(path, "utf8").trim();
  } catch {
    throw new HubFailure(503, `the hub's ${name} file cannot be read`);
  }
  if (!key) {
    throw new HubFailure(503, `the hub's ${name} file is empty`);
  }
  return key;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/** Whether the request carries the hub's access key, compared in constant time. */
function authorized(request: Request, accessKey: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const given = /^Bearer (.+)$/.exec(header)?.[1] ?? "";
  return timingSafeEqual(digest(given), digest(accessKey));
}

function answer(status: number, body: Json, headers: Record<string, string> = {}): Response {
  return new Response(`${dumps(body)}\n`, {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      [HUB_HEADER]: numberText(HUB_ANSWER_VERSION),
      ...headers,
    },
  });
}

/** How long an account's last good reading stands in for one that failed. */
export const HUB_STALE_S = 30 * 60;
/** How long an account is left alone after its usage endpoint said 429 without a Retry-After. */
export const HUB_BACKOFF_S = 600;

type Upstream = { readonly data: unknown } | { readonly detail: string; readonly retryAfter: number | null };

/** The Retry-After seconds in api-call's header map (header name to list of values). */
function retryAfter(headers: unknown): number | null {
  if (!isRecord(headers)) {
    return null;
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "retry-after");
  const value = key === undefined ? undefined : headers[key];
  const first = Array.isArray(value) ? value[0] : value;
  const seconds = typeof first === "string" ? parseIntText(first) : null;
  return seconds !== null && seconds >= 0 ? seconds : null;
}

/** One upstream GET with an account's login, through CLIProxyAPI's api-call; the body's JSON or why not. */
async function upstream(
  options: HubServeOptions,
  managementKey: string,
  authIndex: string,
  url: string,
  header: Record<string, string>,
  host: Host,
): Promise<Upstream> {
  let response: Response;
  try {
    response = await host.fetch(`${options.cliproxy}/v0/management/api-call`, {
      method: "POST",
      headers: { Authorization: `Bearer ${managementKey}`, "Content-Type": "application/json" },
      body: dumps({ auth_index: authIndex, method: "GET", url, header }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { detail: "the hub did not answer", retryAfter: null };
  }
  if (response.status !== 200) {
    return { detail: `the hub could not make the call (HTTP ${response.status})`, retryAfter: null };
  }
  try {
    const call = parseJson(await response.text());
    const status = get(call, "status_code");
    if (typeof status !== "number" || status < 200 || status > 299) {
      const limited = status === 429 ? (retryAfter(get(call, "header")) ?? HUB_BACKOFF_S) : null;
      return { detail: `HTTP ${typeof status === "number" ? status : "?"}`, retryAfter: limited };
    }
    const body = get(call, "body");
    return { data: parseJson(typeof body === "string" ? body : "") };
  } catch {
    return { detail: "an answer agent-pace does not read", retryAfter: null };
  }
}

interface AccountRead {
  readonly windows: UsageWindow[];
  readonly banked: Banked | null;
  readonly plan: string | null;
}

type ReadResult = AccountRead | { readonly detail: string; readonly retryAfter: number | null };

const UNREADABLE = { detail: "an answer agent-pace does not read", retryAfter: null };

async function readClaudeAccount(
  options: HubServeOptions,
  managementKey: string,
  authIndex: string,
  version: string,
  host: Host,
): Promise<ReadResult> {
  const header = claudeUsageHeaders("Bearer $TOKEN$", version);
  const got = await upstream(options, managementKey, authIndex, USAGE_URL, header, host);
  if ("detail" in got) {
    return got;
  }
  try {
    return {
      windows: claudeWindows(got.data, host.now()),
      banked: claudeBanked(got.data).banked,
      plan: null,
    };
  } catch {
    return UNREADABLE;
  }
}

async function readCodexAccount(
  options: HubServeOptions,
  managementKey: string,
  authIndex: string,
  file: Record<string, unknown>,
  host: Host,
): Promise<ReadResult> {
  const account = get(file, "id_token");
  const accountId = isRecord(account) ? account.chatgpt_account_id : undefined;
  // the headers Codex's own clients send ChatGPT's backend
  const header: Record<string, string> = {
    Authorization: "Bearer $TOKEN$",
    "OpenAI-Beta": "codex-1",
    Originator: "Codex Desktop",
    ...(typeof accountId === "string" && accountId ? { "Chatgpt-Account-Id": accountId } : {}),
  };
  const got = await upstream(options, managementKey, authIndex, CODEX_USAGE_URL, header, host);
  if ("detail" in got) {
    return got;
  }
  let usage: ReturnType<typeof codexUsageWindows>;
  try {
    const now = host.now();
    usage = codexUsageWindows(got.data, now, now);
  } catch {
    return UNREADABLE;
  }
  let banked: Banked | null = usage.available === 0 ? { count: 0, credits: [] } : null;
  if (usage.available !== 0) {
    // the expiries are in a list of their own
    const list = await upstream(options, managementKey, authIndex, CODEX_RESET_CREDITS_URL, header, host);
    try {
      banked = "data" in list ? codexResetCredits(list.data) : null;
    } catch {
      banked = null;
    }
    if (banked === null && usage.available !== null) {
      banked = { count: usage.available, credits: null };
    }
  }
  const tokenPlan = isRecord(account) ? account.plan_type : undefined;
  return {
    windows: usage.windows,
    banked,
    plan: usage.plan ?? (typeof tokenPlan === "string" && tokenPlan ? tokenPlan : null),
  };
}

function windowJson(w: UsageWindow): JsonObject {
  return { name: w.name, used: float(w.used), resets_at: float(w.resetsAt), length_s: w.lengthS };
}

function bankedJson(banked: Banked | null): Json {
  if (banked === null) {
    return null;
  }
  return {
    count: banked.count,
    credits:
      banked.credits === null
        ? null
        : banked.credits.map((c) => ({ expires_at: float(c.expiresAt), title: c.title, clears: c.clears })),
  };
}

/**
 * What the service keeps of each account between reads: its last good reading, so one that
 * fails for a while (often a 429) stays in the pool with what it last said, and how long a 429
 * asked to be left alone.
 */
class AccountMemory {
  private readonly last = new Map<string, { read: AccountRead; at: number }>();
  private readonly quiet = new Map<string, { until: number; detail: string }>();

  /** Forgets the accounts under this prefix that the hub no longer lists. */
  keepOnly(prefix: string, keys: ReadonlySet<string>): void {
    for (const map of [this.last, this.quiet]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix) && !keys.has(key)) {
          map.delete(key);
        }
      }
    }
  }

  /** The account's reading now: read upstream, or the last good one while it fails or rests. */
  async read(
    key: string,
    now: number,
    fetchRead: () => Promise<ReadResult>,
  ): Promise<{ read: AccountRead; at: number; detail: string | null } | { detail: string }> {
    const resting = this.quiet.get(key);
    let failed: string;
    if (resting && now < resting.until) {
      failed = resting.detail;
    } else {
      const got = await fetchRead();
      if (!("detail" in got)) {
        this.last.set(key, { read: got, at: now });
        this.quiet.delete(key);
        return { read: got, at: now, detail: null };
      }
      failed = got.detail;
      if (got.retryAfter !== null) {
        this.quiet.set(key, { until: now + Math.max(HUB_CACHE_S, got.retryAfter), detail: got.detail });
      }
    }
    const kept = this.last.get(key);
    if (!kept || now - kept.at > HUB_STALE_S) {
      return { detail: failed };
    }
    // a window that has reset since is no longer running
    const windows = kept.read.windows.filter((w) => w.resetsAt > now);
    return { read: { ...kept.read, windows }, at: kept.at, detail: failed };
  }
}

/** An operator's note names the account, unless it looks like an email address. */
function labelOf(file: Record<string, unknown>, provider: Source, place: number): string {
  const note = typeof file.note === "string" ? file.note.trim() : "";
  return note && !note.includes("@") ? note : `${provider} ${place}`;
}

/** Every account of one provider on the hub, read upstream now (or from memory, see AccountMemory). */
async function readProvider(
  provider: Source,
  options: HubServeOptions,
  memory: AccountMemory,
  host: Host,
): Promise<JsonObject> {
  const managementKey = keyFile(options, "management-key");
  let response: Response;
  try {
    response = await host.fetch(`${options.cliproxy}/v0/management/auth-files`, {
      headers: { Authorization: `Bearer ${managementKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new HubFailure(502, "CLIProxyAPI's management API did not answer");
  }
  if (response.status !== 200) {
    throw new HubFailure(502, `CLIProxyAPI's management API answered HTTP ${response.status}`);
  }
  let files: unknown;
  try {
    files = get(parseJson(await response.text()), "files");
  } catch {
    files = null;
  }
  if (!Array.isArray(files)) {
    throw new HubFailure(502, "CLIProxyAPI's management API listed no accounts agent-pace reads");
  }
  const mine = files.filter(
    (f): f is Record<string, unknown> =>
      isRecord(f) && typeof f.provider === "string" && f.provider.trim().toLowerCase() === provider,
  );
  let version = CLAUDE_CLI_FALLBACK;
  if (provider === "claude") {
    try {
      version = claudeCliVersion(options.state, host);
    } catch {
      // the built-in one
    }
  }
  const observedAt = host.now();
  const keyOf = (authIndex: string) => `${provider}\u0000${authIndex}`;
  memory.keepOnly(
    keyOf(""),
    new Set(mine.flatMap((f) => (typeof f.auth_index === "string" ? [keyOf(f.auth_index)] : []))),
  );
  const accounts = await Promise.all(
    mine.map(async (file, i): Promise<JsonObject> => {
      const weight = isPythonInt(file.weight) && typeof file.weight === "number" ? file.weight : null;
      const account = get(file, "id_token");
      const tokenPlan = isRecord(account) && typeof account.plan_type === "string" ? account.plan_type : null;
      const base = {
        label: labelOf(file, provider, i + 1),
        plan: tokenPlan,
        weight,
        cooling_down: file.unavailable === true,
      };
      const left = (state: string, detail: string | null): JsonObject => ({
        ...base,
        state,
        detail,
        read_at: null,
        windows: [],
        banked: null,
      });
      if (file.disabled === true) {
        return left("disabled", null);
      }
      const authIndex = file.auth_index;
      if (typeof authIndex !== "string" || !authIndex) {
        return left("unreadable", "the hub lists it without an auth_index");
      }
      const got = await memory.read(keyOf(authIndex), host.now(), () =>
        provider === "claude"
          ? readClaudeAccount(options, managementKey, authIndex, version, host)
          : readCodexAccount(options, managementKey, authIndex, file, host),
      );
      if (!("read" in got)) {
        return left("unreadable", got.detail);
      }
      return {
        ...base,
        plan: got.read.plan ?? tokenPlan,
        state: "ok",
        detail: got.detail,
        read_at: float(got.at),
        windows: got.read.windows.map(windowJson),
        banked: bankedJson(got.read.banked),
      };
    }),
  );
  return { version: HUB_ANSWER_VERSION, provider, observed_at: float(observedAt), accounts };
}

/**
 * The service's request handler. GET /v1/usage/<claude|codex> (or the same under /agent-pace,
 * as the tailnet address has it) with the hub's access key answers each account's usage, read
 * at most once a minute per provider however many clients ask.
 */
export function hubHandler(options: HubServeOptions, host: Host): (request: Request) => Promise<Response> {
  const memory = new AccountMemory();
  const cache = new Map<Source, { at: number | null; value: Promise<JsonObject> }>();
  const cached = (provider: Source): Promise<JsonObject> => {
    const hit = cache.get(provider);
    // a read in flight is shared; a finished one is kept a minute from when it finished
    if (hit && (hit.at === null || host.monotonic() - hit.at < HUB_CACHE_S)) {
      return hit.value;
    }
    const entry: { at: number | null; value: Promise<JsonObject> } = {
      at: null,
      value: readProvider(provider, options, memory, host),
    };
    cache.set(provider, entry);
    entry.value.then(
      () => {
        entry.at = host.monotonic();
      },
      () => {
        // a failed read is not kept: the next request tries again
        if (cache.get(provider) === entry) {
          cache.delete(provider);
        }
      },
    );
    return entry.value;
  };

  return async (request) => {
    const path = new URL(request.url).pathname.replace(/^\/agent-pace(?=\/)/, "");
    const provider = SOURCES.find((s) => path === `/v1/usage/${s}`);
    // /v1/hub says this is the service without reading any account, so a client that has not
    // met this address yet can tell it from a gateway within a short wait
    if (provider === undefined && path !== HUB_HELLO) {
      return answer(404, { error: "not found" });
    }
    if (request.method !== "GET") {
      return answer(405, { error: "only GET" }, { allow: "GET" });
    }
    try {
      if (!authorized(request, keyFile(options, "access-key"))) {
        return answer(401, { error: "the hub's access key is required" }, { "www-authenticate": "Bearer" });
      }
      if (provider === undefined) {
        return answer(200, { version: HUB_ANSWER_VERSION });
      }
      return answer(200, await cached(provider));
    } catch (error) {
      const failure =
        error instanceof HubFailure
          ? error
          : new HubFailure(500, "the hub's agent-pace failed reading the accounts");
      host.stderr(`agent-pace hub: ${provider ?? "hub"}: ${failure.message}\n`);
      return answer(failure.status, { error: failure.message });
    }
  };
}

const HUB_USAGE = (prog: string) =>
  `usage: ${prog} serve [-h] [--port PORT] [--keys DIR] [--cliproxy URL] [--state DIR]\n`;

const HUB_HELP = (prog: string, host: Host) =>
  `${HUB_USAGE(prog)}
Serve the CLIProxyAPI hub's Claude and Codex account usage to agent-pace on its clients. Run it
on the hub, beside CLIProxyAPI: it listens on 127.0.0.1 only and reads CLIProxyAPI's management
API with the management key, which never leaves the hub. Clients send the hub's access key.
GET /v1/usage/claude and /v1/usage/codex (also under /agent-pace/) answer each account's
windows and banked resets, read at most once a minute.

options:
  -h, --help      show this help message and exit
  --port PORT     the port on 127.0.0.1 to listen on (default ${numberText(HUB_PORT)})
  --keys DIR      the directory with the access-key and management-key files
                  (default ${join(homeDirectory(host.env), ".config", "cliproxyapi")})
  --cliproxy URL  CLIProxyAPI on this machine (default http://127.0.0.1:8317)
  --state DIR     where the Claude Code version it claims is remembered
                  (default ${defaultStateDirectory(host.env)})
`;

type HubArgs =
  | { readonly kind: "serve"; readonly options: HubServeOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

/** `hub serve` and its options. */
export function parseHubArgs(argv: readonly string[], host: Host): HubArgs {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    return argv.length === 0
      ? { kind: "error", message: "the following arguments are required: serve" }
      : { kind: "help" };
  }
  if (argv[0] !== "serve") {
    return { kind: "error", message: `invalid choice: '${argv[0]}' (choose from 'serve')` };
  }
  const values = {
    port: numberText(HUB_PORT),
    keys: join(homeDirectory(host.env), ".config", "cliproxyapi"),
    cliproxy: "http://127.0.0.1:8317",
    state: defaultStateDirectory(host.env),
  };
  const flags = ["--port", "--keys", "--cliproxy", "--state"] as const;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      return { kind: "help" };
    }
    const eq = arg.indexOf("=");
    const flag = flags.find((f) => f === (eq >= 0 ? arg.slice(0, eq) : arg));
    if (flag === undefined) {
      return { kind: "error", message: `unrecognized arguments: ${arg}` };
    }
    let value: string | undefined = eq >= 0 ? arg.slice(eq + 1) : argv[i + 1];
    if (eq < 0) {
      i++;
    }
    if (value === undefined) {
      return { kind: "error", message: `argument ${flag}: expected one argument` };
    }
    value = value.trim();
    values[flag.slice(2) as keyof typeof values] = value;
  }
  const port = parseIntText(values.port);
  if (port === null || port < 1 || port > 65535) {
    return { kind: "error", message: `argument --port: not a port: '${values.port}'` };
  }
  let cliproxy: URL;
  try {
    cliproxy = new URL(values.cliproxy);
  } catch {
    return { kind: "error", message: `argument --cliproxy: not an address: '${values.cliproxy}'` };
  }
  // the management key goes with every call: it stays on this machine
  if (
    !["http:", "https:"].includes(cliproxy.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(cliproxy.hostname)
  ) {
    return {
      kind: "error",
      message: "argument --cliproxy: must be CLIProxyAPI on this machine (127.0.0.1, localhost or [::1])",
    };
  }
  return {
    kind: "serve",
    options: { port, keys: values.keys, cliproxy: values.cliproxy.replace(/\/+$/, ""), state: values.state },
  };
}

/** Starts the service on 127.0.0.1; it runs until the process ends. */
export function startHub(options: HubServeOptions, host: Host): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port: options.port, fetch: hubHandler(options, host) });
}

/** `agent-pace hub ...`; returns the exit status (serving does not return). */
export async function hubMain(argv: readonly string[], prog: string, host: Host): Promise<number> {
  const parsed = parseHubArgs(argv, host);
  if (parsed.kind === "help") {
    host.stdout(HUB_HELP(prog, host));
    return 0;
  }
  if (parsed.kind === "error") {
    host.stderr(`${HUB_USAGE(prog)}${prog}: error: ${parsed.message}\n`);
    return 2;
  }
  const { options } = parsed;
  try {
    keyFile(options, "access-key");
    keyFile(options, "management-key");
  } catch (error) {
    if (error instanceof HubFailure) {
      host.stderr(
        `agent-pace hub: ${error.message} (in ${options.keys}: the hub's access-key and management-key files)\n`,
      );
      return 1;
    }
    throw error;
  }
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = startHub(options, host);
  } catch (error) {
    host.stderr(
      `agent-pace hub: cannot listen on 127.0.0.1:${numberText(options.port)}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
  host.stderr(
    `agent-pace hub: serving Claude and Codex usage on http://127.0.0.1:${numberText(server.port ?? options.port)}/v1/usage/\n`,
  );
  await new Promise<never>(() => {});
  return 0;
}
