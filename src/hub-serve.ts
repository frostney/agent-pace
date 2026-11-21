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

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_CLI_FALLBACK,
  claudeBanked,
  claudeCliVersion,
  claudeLimits,
  claudeResetGrant,
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

type ReadFailure = {
  readonly detail: string;
  readonly retryAfter: number | null;
  readonly upstreamStatus?: number | undefined;
};
type Upstream = { readonly data: unknown } | ReadFailure;

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
  logStatus?: (status: number | null) => void,
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
    logStatus?.(null);
    return { detail: "the hub did not answer", retryAfter: null };
  }
  if (response.status !== 200) {
    logStatus?.(null);
    return { detail: `the hub could not make the call (HTTP ${response.status})`, retryAfter: null };
  }
  try {
    const call = parseJson(await response.text());
    const status = get(call, "status_code");
    logStatus?.(typeof status === "number" ? status : null);
    if (typeof status !== "number" || status < 200 || status > 299) {
      const limited = status === 429 ? (retryAfter(get(call, "header")) ?? HUB_BACKOFF_S) : null;
      return {
        detail: `HTTP ${typeof status === "number" ? status : "?"}`,
        retryAfter: limited,
        upstreamStatus: typeof status === "number" ? status : undefined,
      };
    }
    const body = get(call, "body");
    return { data: parseJson(typeof body === "string" ? body : "") };
  } catch {
    return { detail: "an answer agent-pace does not read", retryAfter: null };
  }
}

interface AccountRead {
  readonly windows: UsageWindow[];
  /** The windows it has a limit on, started or not; null when the provider does not say. */
  readonly limits: string[] | null;
  readonly banked: Banked | null;
  readonly plan: string | null;
  readonly grant?: ReturnType<typeof claudeResetGrant>;
}

type ReadResult = AccountRead | ReadFailure;

const RESET_IN_PROGRESS = { detail: "a Claude reset is in progress", retryAfter: null };
const UNREADABLE = { detail: "an answer agent-pace does not read", retryAfter: null };

async function readClaudeAccount(
  options: HubServeOptions,
  managementKey: string,
  authIndex: string,
  version: string,
  host: Host,
  source: "pool" | "reset",
): Promise<ReadResult> {
  const header = claudeUsageHeaders("Bearer $TOKEN$", version);
  // The pool only needs windows and grants; skip the unrelated spend lookup.
  const got = await upstream(
    options,
    managementKey,
    authIndex,
    `${USAGE_URL}&skip_spend=1`,
    header,
    host,
    (status) =>
      host.stderr(
        `agent-pace hub: claude usage ${source}: ${status === null ? "no upstream status" : `HTTP ${status}`}\n`,
      ),
  );
  if ("detail" in got) {
    return got;
  }
  try {
    return {
      windows: claudeWindows(got.data, host.now()),
      limits: claudeLimits(got.data),
      banked: claudeBanked(got.data).banked,
      plan: null,
      grant: claudeResetGrant(got.data, host.now()),
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
    limits: null,
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
type Observation = {
  readonly read: AccountRead;
  readonly at: number;
  readonly detail: string | null;
  readonly failure?: ReadFailure;
};
type AccountObservation = Observation | ReadFailure;
type CachedRead = { at: number | null; readonly value: Promise<AccountObservation> };

class AccountMemory {
  private readonly last = new Map<string, { read: AccountRead; at: number }>();
  private readonly quiet = new Map<string, { until: number; failure: ReadFailure }>();
  private readonly shared = new Map<string, CachedRead>();
  // The dashboard's relay times out at 40 seconds. If it disappears, clear the hold after a minute.
  private readonly resets = new Map<string, { id: string; until: number }>();

  /** Forgets the accounts under this prefix that the hub no longer lists. */
  keepOnly(prefix: string, keys: ReadonlySet<string>, now: number): void {
    for (const map of [this.last, this.shared]) {
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix) && !keys.has(key)) {
          map.delete(key);
        }
      }
    }
    for (const [key, wait] of this.quiet) {
      if (wait.until <= now || (prefix === "codex\u0000" && key.startsWith(prefix) && !keys.has(key))) {
        this.quiet.delete(key);
      }
    }
  }

  /** A file update or a disable/enable cycle may reuse the same upstream login. */
  private backoffKey(key: string): string {
    return key.startsWith("claude\u0000") ? key.slice(0, key.lastIndexOf("\u0000")) : key;
  }

  /** One current Claude observation shared between the pool and the reset check. */
  readShared(key: string, host: Host, fetchRead: () => Promise<ReadResult>): Promise<AccountObservation> {
    if (this.resetInProgress(key, host.monotonic())) {
      return Promise.resolve(RESET_IN_PROGRESS);
    }
    const now = host.now();
    if (this.backoffLeft(key, now) > 0) {
      return this.read(key, now, fetchRead);
    }
    const hit = this.shared.get(key);
    if (hit && (hit.at === null || host.monotonic() - hit.at < HUB_CACHE_S)) {
      return hit.value;
    }
    const entry: CachedRead = { at: null, value: this.read(key, now, fetchRead, () => host.now()) };
    this.shared.set(key, entry);
    entry.value.then(
      (result) => {
        if (result.detail !== null && this.shared.get(key) === entry) {
          this.shared.delete(key);
        }
        entry.at = host.monotonic();
      },
      () => {
        if (this.shared.get(key) === entry) this.shared.delete(key);
      },
    );
    return entry.value;
  }

  resetInProgress(key: string, now: number): boolean {
    const slot = this.backoffKey(key);
    const active = this.resets.get(slot);
    if (active && now < active.until) {
      return true;
    }
    this.resets.delete(slot);
    return false;
  }

  /** Forget the reading before the claim can start and hold off reads until the claim ends. */
  reserveReset(key: string, now: number): string | null {
    if (this.resetInProgress(key, now)) {
      return null;
    }
    for (const [oldKey, active] of this.resets) {
      if (now >= active.until) this.resets.delete(oldKey);
    }
    const id = randomUUID();
    const slot = this.backoffKey(key);
    this.resets.set(slot, { id, until: now + HUB_CACHE_S });
    for (const map of [this.shared, this.last]) {
      for (const observation of map.keys()) {
        if (observation.startsWith(`${slot}\u0000`)) map.delete(observation);
      }
    }
    return id;
  }

  finishReset(key: string, id: string): void {
    const slot = this.backoffKey(key);
    if (this.resets.get(slot)?.id === id) {
      this.resets.delete(slot);
    }
  }

  /** An awaited credential check can outlive or overlap eviction of the reading. */
  stillCurrent(key: string, result: Promise<AccountObservation>, now: number): boolean {
    return this.shared.get(key)?.value === result && now < this.freshUntil(key);
  }

  freshUntil(key: string): number {
    const at = this.shared.get(key)?.at;
    return at == null ? (this.resets.get(this.backoffKey(key))?.until ?? Infinity) : at + HUB_CACHE_S;
  }

  backoffLeft(key: string, now: number): number {
    return Math.max(0, Math.ceil((this.quiet.get(this.backoffKey(key))?.until ?? now) - now));
  }

  /** The account's reading now: read upstream, or the last good one while it fails or rests. */
  async read(
    key: string,
    now: number,
    fetchRead: () => Promise<ReadResult>,
    retryFrom = () => now,
  ): Promise<AccountObservation> {
    const waitKey = this.backoffKey(key);
    const resting = this.quiet.get(waitKey);
    let failed: ReadFailure;
    if (resting && now < resting.until) {
      failed = resting.failure;
    } else {
      const got = await fetchRead();
      if (!("detail" in got)) {
        this.last.set(key, { read: got, at: now });
        if ((this.quiet.get(waitKey)?.until ?? now) <= now) {
          this.quiet.delete(waitKey);
        }
        return { read: got, at: now, detail: null };
      }
      failed = got;
      if (got.retryAfter !== null) {
        const until = retryFrom() + Math.max(HUB_CACHE_S, got.retryAfter);
        if ((this.quiet.get(waitKey)?.until ?? now) < until) {
          this.quiet.set(waitKey, { until, failure: got });
        }
      }
    }
    const kept = this.last.get(key);
    if (!kept || now - kept.at > HUB_STALE_S) {
      return failed;
    }
    // a window that has reset since is no longer running
    const windows = kept.read.windows.filter((w) => w.resetsAt > now);
    return { read: { ...kept.read, windows }, at: kept.at, detail: failed.detail, failure: failed };
  }
}

/** An operator's note names the account, unless it looks like an email address. */
function labelOf(file: Record<string, unknown>, provider: Source, place: number): string {
  const note = typeof file.note === "string" ? file.note.trim() : "";
  return note && !note.includes("@") ? note : `${provider} ${place}`;
}

async function listAccounts(
  provider: Source,
  options: HubServeOptions,
  managementKey: string,
  host: Host,
): Promise<Record<string, unknown>[]> {
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
  return files.filter(
    (f): f is Record<string, unknown> =>
      isRecord(f) && typeof f.provider === "string" && f.provider.trim().toLowerCase() === provider,
  );
}

function claudeVersion(options: HubServeOptions, host: Host): string {
  try {
    return claudeCliVersion(options.state, host);
  } catch {
    return CLAUDE_CLI_FALLBACK;
  }
}

/** The index identifies a slot. A relogin in that slot must discard its old observation. */
function claudeRevision(file: Record<string, unknown>): string {
  const fields = ["id", "name", "email", "created_at", "modtime", "last_refresh"];
  return digest(
    JSON.stringify(fields.map((key) => (typeof file[key] === "string" ? file[key] : null))),
  ).toString("hex");
}

function claudeAccountKey(index: string, revision: string): string {
  return `claude\u0000${index}\u0000${revision}`;
}

function accountKey(provider: Source, index: string, file: Record<string, unknown>): string {
  return provider === "claude" ? claudeAccountKey(index, claudeRevision(file)) : `codex\u0000${index}`;
}

/** Every account of one provider on the hub, read upstream now (or from memory, see AccountMemory). */
async function readProvider(
  provider: Source,
  options: HubServeOptions,
  memory: AccountMemory,
  host: Host,
): Promise<{ body: JsonObject; freshUntil: number }> {
  const managementKey = keyFile(options, "management-key");
  const mine = await listAccounts(provider, options, managementKey, host);
  const version = provider === "claude" ? claudeVersion(options, host) : "";
  const observedAt = host.now();
  memory.keepOnly(
    `${provider}\u0000`,
    new Set(
      mine.flatMap((f) =>
        typeof f.auth_index === "string" && (provider !== "claude" || f.disabled !== true)
          ? [accountKey(provider, f.auth_index, f)]
          : [],
      ),
    ),
    observedAt,
  );
  let freshUntil = Infinity;
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
        limits: null,
        banked: null,
      });
      if (file.disabled === true) {
        return left("disabled", null);
      }
      const authIndex = file.auth_index;
      if (typeof authIndex !== "string" || !authIndex) {
        return left("unreadable", "the hub lists it without an auth_index");
      }
      const key = accountKey(provider, authIndex, file);
      const got =
        provider === "claude"
          ? await memory.readShared(key, host, () =>
              readClaudeAccount(options, managementKey, authIndex, version, host, "pool"),
            )
          : await memory.read(key, host.now(), () =>
              readCodexAccount(options, managementKey, authIndex, file, host),
            );
      if (provider === "claude" && (got.detail === null || got === RESET_IN_PROGRESS)) {
        freshUntil = Math.min(freshUntil, memory.freshUntil(key));
      }
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
        limits: got.read.limits,
        banked: bankedJson(got.read.banked),
      };
    }),
  );
  return {
    body: { version: HUB_ANSWER_VERSION, provider, observed_at: float(observedAt), accounts },
    freshUntil,
  };
}

/**
 * The service's request handler. GET /v1/usage/<claude|codex> (or the same under /agent-pace,
 * as the tailnet address has it) with the hub's access key answers each account's usage. The
 * local dashboard uses the management-key reset-grant route for fresh Claude grants.
 */
export function hubHandler(options: HubServeOptions, host: Host): (request: Request) => Promise<Response> {
  const memory = new AccountMemory();
  type Snapshot = { body: JsonObject; freshUntil: number };
  const cache = new Map<Source, { until: number | null; value: Promise<Snapshot> }>();
  const cached = (provider: Source): Promise<Snapshot> => {
    const hit = cache.get(provider);
    if (hit && (hit.until === null || host.monotonic() < hit.until)) {
      return hit.value;
    }
    const entry: { until: number | null; value: Promise<Snapshot> } = {
      until: null,
      value: readProvider(provider, options, memory, host),
    };
    cache.set(provider, entry);
    entry.value.then(
      ({ freshUntil }) => {
        entry.until = Math.min(host.monotonic() + HUB_CACHE_S, freshUntil);
      },
      () => {
        if (cache.get(provider) === entry) {
          cache.delete(provider);
        }
      },
    );
    return entry.value;
  };

  async function resetGrant(request: Request, url: URL): Promise<Response> {
    const managementKey = keyFile(options, "management-key");
    if (!authorized(request, managementKey)) {
      return answer(401, { error: "the hub's management key is required" }, { "www-authenticate": "Bearer" });
    }
    const index = url.searchParams.get("auth_index");
    const revision = request.headers.get("x-auth-revision");
    if (!index || revision === null || !/^[0-9a-f]{64}$/.test(revision)) {
      return answer(400, { error: "an account and its credential revision are required" });
    }
    const key = claudeAccountKey(index, revision);
    const reservation = request.headers.get("x-reset-reservation");
    if (request.method === "DELETE") {
      if (!reservation) return answer(400, { error: "a reset reservation is required" });
      memory.finishReset(key, reservation);
      cache.delete("claude");
      return answer(200, { released: true });
    }
    let requestedGrant: string | null = null;
    if (request.method === "POST") {
      const body: unknown = await request.json().catch(() => null);
      if (!isRecord(body) || typeof body.grant !== "string" || !body.grant) {
        return answer(400, { error: "the confirmed reset grant is required" });
      }
      requestedGrant = body.grant;
    }
    const sameCredential = async (): Promise<boolean> => {
      const files = await listAccounts("claude", options, managementKey, host);
      const file = files.find((candidate) => candidate.auth_index === index);
      return file !== undefined && file.disabled !== true && claudeRevision(file) === revision;
    };
    const credentialChanged = () =>
      answer(409, { code: "credential_changed", error: "the account changed; refresh the dashboard" });
    if (!(await sameCredential())) {
      return credentialChanged();
    }
    const reading = memory.readShared(key, host, async () => {
      const result = await readClaudeAccount(
        options,
        managementKey,
        index,
        claudeVersion(options, host),
        host,
        "reset",
      );
      cache.delete("claude");
      return result;
    });
    const got = await reading;
    if (!(await sameCredential())) {
      return credentialChanged();
    }
    if (got === RESET_IN_PROGRESS || memory.resetInProgress(key, host.monotonic())) {
      return answer(409, { code: "reset_in_progress", error: RESET_IN_PROGRESS.detail });
    }
    const wait = memory.backoffLeft(key, host.now());
    if (wait > 0) {
      return answer(
        429,
        { error: "Claude is rate limiting usage checks" },
        { "retry-after": numberText(wait) },
      );
    }
    if (got.detail !== null || !("read" in got)) {
      const failed = "read" in got ? got.failure?.upstreamStatus : got.upstreamStatus;
      return answer(502, { error: got.detail, upstream_status: failed ?? null });
    }
    const changed = () =>
      answer(409, {
        code: "grant_changed",
        error: "Claude's next reset changed; check the account again",
      });
    if (!memory.stillCurrent(key, reading, host.monotonic())) {
      return changed();
    }
    const current = got.read.grant;
    const grant =
      current && (current.expires_at === null || current.expires_at > host.now()) ? current : null;
    if (request.method === "POST") {
      if (grant?.id !== requestedGrant) {
        return changed();
      }
      const id = memory.reserveReset(key, host.monotonic());
      if (id === null) return answer(409, { code: "reset_in_progress", error: RESET_IN_PROGRESS.detail });
      cache.delete("claude");
      return answer(200, { reservation: id });
    }
    return answer(200, { grant });
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/agent-pace(?=\/)/, "");
    const provider = SOURCES.find((s) => path === `/v1/usage/${s}`);
    // /v1/hub says this is the service without reading any account, so a client that has not
    // met this address yet can tell it from a gateway within a short wait
    const isGrant = path === "/v1/claude/reset-grant";
    if (!isGrant && provider === undefined && path !== HUB_HELLO) {
      return answer(404, { error: "not found" });
    }
    if (
      request.method !== "GET" &&
      !(isGrant && (request.method === "POST" || request.method === "DELETE"))
    ) {
      return answer(
        405,
        { error: isGrant ? "only GET, POST and DELETE" : "only GET" },
        { allow: isGrant ? "GET, POST, DELETE" : "GET" },
      );
    }
    try {
      if (isGrant) return await resetGrant(request, url);
      if (!authorized(request, keyFile(options, "access-key"))) {
        return answer(401, { error: "the hub's access key is required" }, { "www-authenticate": "Bearer" });
      }
      if (provider === undefined) {
        return answer(200, { version: HUB_ANSWER_VERSION });
      }
      return answer(200, (await cached(provider)).body);
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
