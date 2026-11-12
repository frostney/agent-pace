// A machine whose Claude Code or Codex goes through a CLIProxyAPI auth hub has no login of its
// own to read: the hub holds the accounts. Such a client reads the accounts' usage from
// `agent-pace hub serve` on the hub, at <hub>/agent-pace/v1/usage/<source>, with the access key
// its Claude Code or Codex already sends the hub, and paces their pool.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExitError, NetworkError } from "./errors.ts";
import { claudeHome, codexHome, type Host } from "./host.ts";
import { roundTo } from "./python-format.ts";
import { get, isPythonInt, isRecord, type Json, numericValue, parseJson } from "./python-json.ts";
import type { Banked, Credit, HubAccount, HubAccountState, HubPool, Source, UsageWindow } from "./usage.ts";

/** The version of the answer `agent-pace hub serve` gives; a client reads only this one. */
export const HUB_ANSWER_VERSION = 1;

/** The header on every answer of `agent-pace hub serve`: an address without it is no hub. */
export const HUB_HEADER = "x-agent-pace-hub";

/** Answers with the service's header and nothing else: how a client first meets a hub. */
export const HUB_HELLO = "/v1/hub";

/** Where a hub client sends its usage request, under the hub's own address. */
export const HUB_PATH = "/agent-pace/v1/usage";

const PROVIDER_NAMES: Record<Source, string> = { claude: "Claude", codex: "Codex" };

/** The hub this machine's Claude Code or Codex goes through, and the access key it sends. */
export interface HubLogin {
  readonly url: string;
  readonly key: string;
  /** The file both came from, for messages. */
  readonly from: string;
}

/**
 * A hub address as Claude Code (`ANTHROPIC_BASE_URL`) or Codex (`base_url`, ending in /v1)
 * holds it, without the trailing /v1. The access key goes with it, so only https, or plain
 * http to this machine itself, is asked; anything else is no hub (null).
 */
export function hubAddress(raw: string): string | null {
  const url = raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback) ? url : null;
}

function login(url: string, key: string, from: string): HubLogin | null {
  const address = hubAddress(url);
  return address === null ? null : { url: address, key, from };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Claude Code sent to a hub: env.ANTHROPIC_BASE_URL and env.ANTHROPIC_AUTH_TOKEN in settings.json. */
function claudeHub(host: Host): HubLogin | null {
  const path = join(claudeHome(host.env), "settings.json");
  const text = readText(path);
  if (text === null) {
    return null;
  }
  let env: unknown;
  try {
    env = get(JSON.parse(text), "env");
  } catch {
    return null; // not a settings object Claude Code would take either
  }
  const url = isRecord(env) ? env.ANTHROPIC_BASE_URL : undefined;
  const key = isRecord(env) ? env.ANTHROPIC_AUTH_TOKEN : undefined;
  if (typeof url !== "string" || !url || typeof key !== "string" || !key) {
    return null;
  }
  return login(url, key, path);
}

/** Codex sent to a hub: model_provider = "cliproxy" and its [model_providers.cliproxy] table. */
function codexHub(host: Host): HubLogin | null {
  const path = join(codexHome(host.env), "config.toml");
  const text = readText(path);
  if (text === null) {
    return null;
  }
  let config: unknown;
  try {
    config = Bun.TOML.parse(text);
  } catch {
    return null; // Codex cannot read it either
  }
  if (!isRecord(config) || config.model_provider !== "cliproxy") {
    return null;
  }
  const providers = config.model_providers;
  const table = isRecord(providers) ? providers.cliproxy : undefined;
  const url = isRecord(table) ? table.base_url : undefined;
  // the key is in the table, or in the environment variable env_key names
  const inline = isRecord(table) ? table.experimental_bearer_token : undefined;
  const variable = isRecord(table) ? table.env_key : undefined;
  const key =
    typeof inline === "string" && inline
      ? inline
      : typeof variable === "string"
        ? host.env[variable]
        : undefined;
  if (typeof url !== "string" || !url || typeof key !== "string" || !key) {
    return null; // nothing to ask a hub with
  }
  return login(url, key, path);
}

/** The hub this source goes through on this machine; null when it uses its own login. */
export function hubLogin(source: Source, host: Host): HubLogin | null {
  return source === "claude" ? claudeHub(host) : codexHub(host);
}

/** The answer did not have the shape this version reads. */
class Unreadable extends Error {}

function check(ok: boolean): void {
  if (!ok) {
    throw new Unreadable();
  }
}

function numberAt(value: unknown, key: string): number {
  const n = numericValue(get(value, key));
  check(n !== null && Number.isFinite(n));
  return n as number;
}

function stringOrNull(value: unknown): string | null {
  check(value === null || typeof value === "string");
  return value as string | null;
}

const STATES: readonly HubAccountState[] = ["ok", "disabled", "unreadable"];

function parseBanked(value: unknown): Banked | null {
  if (value === null) {
    return null;
  }
  check(isRecord(value) && isPythonInt(get(value, "count")));
  const listed = get(value, "credits");
  if (listed === null) {
    return { count: Number(get(value, "count")), credits: null };
  }
  check(Array.isArray(listed));
  const credits: Credit[] = (listed as unknown[]).map((c) => {
    check(isRecord(c));
    const expires = get(c, "expires_at");
    const clears = get(c, "clears");
    check(expires === null || numericValue(expires) !== null);
    check(clears === null || (Array.isArray(clears) && clears.every((x) => typeof x === "string")));
    return {
      expiresAt: expires === null ? null : (numericValue(expires) as number),
      // decoded from JSON, so it is JSON
      title: (get(c, "title") ?? null) as Json,
      clears: clears as string[] | null,
    };
  });
  return { count: Number(get(value, "count")), credits };
}

function parseAccount(value: unknown, observedAt: number): HubAccount {
  check(isRecord(value));
  const label = get(value, "label");
  const state = get(value, "state");
  const readAt = get(value, "read_at");
  const weight = get(value, "weight");
  const windows = get(value, "windows");
  check(typeof label === "string" && STATES.includes(state as HubAccountState));
  check(weight === null || (isPythonInt(weight) && typeof weight === "number"));
  check(readAt === null || numericValue(readAt) !== null);
  check(typeof get(value, "cooling_down") === "boolean" && Array.isArray(windows));
  const limits = get(value, "limits"); // absent before agent-pace 5.2 on the hub
  check(limits === null || (Array.isArray(limits) && limits.every((x) => typeof x === "string")));
  return {
    label: label as string,
    plan: stringOrNull(get(value, "plan")),
    weight: weight as number | null,
    state: state as HubAccountState,
    detail: stringOrNull(get(value, "detail")),
    readAt: readAt === null ? null : (numericValue(readAt) as number),
    coolingDown: get(value, "cooling_down") === true,
    windows: (windows as unknown[]).map((w) => {
      const name = get(w, "name");
      check(typeof name === "string");
      return {
        name: name as string,
        used: numberAt(w, "used"),
        resetsAt: numberAt(w, "resets_at"),
        lengthS: numberAt(w, "length_s"),
        observedAt,
      };
    }),
    limits: limits as string[] | null,
    banked: parseBanked(get(value, "banked")),
  };
}

/** The hub's answer as a pool; anything not in the shape this version reads ends the command. */
export function parseHubAnswer(data: unknown, source: Source, url: string): HubPool {
  try {
    check(isRecord(data) && get(data, "version") === HUB_ANSWER_VERSION && get(data, "provider") === source);
    const observedAt = numberAt(data, "observed_at");
    const accounts = get(data, "accounts");
    check(Array.isArray(accounts));
    return { url, observedAt, accounts: (accounts as unknown[]).map((a) => parseAccount(a, observedAt)) };
  } catch (error) {
    if (error instanceof Unreadable || error instanceof TypeError) {
      throw new ExitError(
        `agent-pace: the hub at ${url} answered in a form this agent-pace does not read; update agent-pace here and on the hub`,
      );
    }
    throw error;
  }
}

/** The error text in an answer from `agent-pace hub serve`, if it gave one. */
async function answerError(response: Response): Promise<string | null> {
  try {
    const error = get(parseJson(await response.text()), "error");
    return typeof error === "string" ? error : null;
  } catch {
    return null;
  }
}

/** The file that remembers the address that last answered as a hub for this source. */
function confirmedPath(state: string, source: Source): string {
  return join(state, `${source}-pool-hub`);
}

/** Whether this address has answered as a hub before (with the service's header). */
function confirmed(state: string, source: Source, url: string): boolean {
  return readText(confirmedPath(state, source)) === url;
}

function confirm(state: string, source: Source, url: string): void {
  if (confirmed(state, source, url)) {
    return;
  }
  try {
    mkdirSync(state, { recursive: true });
    writeFileSync(confirmedPath(state, source), url);
  } catch {
    // remembered next time
  }
}

/**
 * The accounts on the hub for this source, as `agent-pace hub serve` reports them. An address
 * that has never answered with the service's header (a gateway that is no hub, a hub without
 * the service) gives null, and agent-pace reads this machine as before, also when it cannot be
 * reached. Once an address has answered as a hub (`<source>-pool-hub`), an answer without the
 * header or no answer is a failed reading: a hub whose service is down is still the hub, and
 * this machine's own login is not the one in use.
 */
export async function hubReading(
  source: Source,
  login: HubLogin,
  state: string,
  host: Host,
  fetchFailure: (error: unknown) => string,
): Promise<HubPool | null> {
  const headers = { Authorization: `Bearer ${login.key}` };
  if (!confirmed(state, source, login.url)) {
    // an address not met yet (a gateway, perhaps) gets 10 s to say it is the service, which
    // answers that without reading any account
    let hello: Response;
    try {
      hello = await host.fetch(`${login.url}/agent-pace${HUB_HELLO}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return null;
    }
    if (hello.headers.get(HUB_HEADER) === null) {
      return null;
    }
    if (hello.status === 401 || hello.status === 403) {
      throw new ExitError(`agent-pace: the hub at ${login.url} rejected the access key in ${login.from}`);
    }
    // the header says it is the service: any other answer (an older service without /v1/hub, a
    // hub that cannot read its keys) is the usage request's to report
    confirm(state, source, login.url);
  }
  const known = confirmed(state, source, login.url);
  const url = `${login.url}${HUB_PATH}/${source}`;
  // a hub's cold read asks every account upstream (up to 15 s for the list and 2 x 20 s for a
  // Codex account)
  const signal = AbortSignal.timeout(known ? 90_000 : 10_000);
  let response: Response;
  try {
    response = await host.fetch(url, { headers, signal });
  } catch (error) {
    if (!known) {
      return null;
    }
    throw new NetworkError(signal.aborted ? "timed out" : `<urlopen error ${fetchFailure(error)}>`);
  }
  if (response.headers.get(HUB_HEADER) === null) {
    if (!known) {
      return null;
    }
    throw new NetworkError(
      `the hub at ${login.url} answered without its agent-pace service (HTTP ${response.status}); ` +
        `if it no longer runs one, remove ${confirmedPath(state, source)}`,
    );
  }
  confirm(state, source, login.url);
  if (response.status === 401 || response.status === 403) {
    throw new ExitError(`agent-pace: the hub at ${login.url} rejected the access key in ${login.from}`);
  }
  if (response.status === 404) {
    throw new ExitError(
      `agent-pace: the hub at ${login.url} does not serve ${HUB_PATH}/${source}; update agent-pace on the hub`,
    );
  }
  if (response.status >= 400) {
    const why = await answerError(response);
    throw new NetworkError(why ? `the hub: ${why}` : `HTTP Error ${response.status}: ${response.statusText}`);
  }
  let data: unknown;
  try {
    data = parseJson(await response.text());
  } catch (error) {
    if (error instanceof SyntaxError) {
      data = null; // reported as an answer it does not read
    } else {
      throw new NetworkError(signal.aborted ? "The read operation timed out" : String(error));
    }
  }
  return parseHubAnswer(data, source, login.url);
}

/** An account's share of the pool: its weight on the hub, 1 when it sets none. */
export function capacity(account: HubAccount): number {
  return account.weight ?? 1;
}

/** Whether an account counts in the pool: read, and with a share above 0. */
export function inPool(account: HubAccount): boolean {
  return account.state === "ok" && capacity(account) > 0;
}

/** The accounts the hub routes to (all but the disabled ones). */
export function enabled(pool: HubPool): HubAccount[] {
  return pool.accounts.filter((a) => a.state !== "disabled");
}

/** Whether an account's plan limits this window; with no limits from the hub, every window. */
function limitedBy(account: HubAccount, window: string): boolean {
  return account.limits === null || account.limits.includes(window);
}

/**
 * The pool's windows: for each window name an account in the pool reports, the use is the
 * capacity-weighted mean of the use of the accounts whose plan limits that window (one without
 * that window running counts as 0%; one whose plan has no such limit is not in that window's
 * pool), and the reset is the capacity-weighted mean of the reset times of the accounts with
 * it running (now plus the window's length when none has it running). With every account
 * burning the same share of its own capacity, that mean projected to that reset is the mean of
 * each account projected to its own reset, so the target and the verdict answer for the pool.
 *
 * An account that resets before that mean hands its window back meanwhile: `returns` holds
 * when, and the points of the pool it has used now, which it hands back at least.
 */
export function poolWindows(source: Source, pool: HubPool, now: number): UsageWindow[] {
  const members = pool.accounts.filter(inPool);
  if (members.length === 0) {
    const why = pool.accounts.length === 0 ? "it has none" : accountStates(pool.accounts);
    throw new NetworkError(`no ${PROVIDER_NAMES[source]} account on the hub can be read now (${why})`);
  }
  const lengths = new Map<string, number>();
  for (const a of members) {
    for (const w of a.windows) {
      if (limitedBy(a, w.name)) {
        lengths.set(w.name, Math.max(lengths.get(w.name) ?? 0, w.lengthS));
      }
    }
  }
  if (lengths.size === 0) {
    throw new NetworkError(`the hub's ${PROVIDER_NAMES[source]} accounts report no usage windows`);
  }
  const out: UsageWindow[] = [];
  for (const [name, lengthS] of lengths) {
    const counted = members.filter((a) => limitedBy(a, name));
    const total = counted.reduce((sum, a) => sum + capacity(a), 0);
    let used = 0;
    let resetWeight = 0;
    let resetSum = 0;
    for (const a of counted) {
      const w = a.windows.find((x) => x.name === name);
      if (w) {
        used += capacity(a) * w.used;
        resetWeight += capacity(a);
        resetSum += capacity(a) * w.resetsAt;
      }
    }
    const resetsAt = resetWeight > 0 ? resetSum / resetWeight : now + lengthS;
    const returns: [number, number][] = [];
    for (const a of counted) {
      const w = a.windows.find((x) => x.name === name);
      if (w && w.used > 0 && w.resetsAt > now && w.resetsAt < resetsAt) {
        returns.push([w.resetsAt, (capacity(a) * w.used) / total]);
      }
    }
    out.push({
      name,
      used: roundTo(used / total, 2),
      resetsAt,
      lengthS,
      observedAt: pool.observedAt,
      ...(returns.length > 0 ? { returns: returns.sort((a, b) => a[0] - b[0]) } : {}),
    });
  }
  return out.sort((a, b) => a.lengthS - b.lengthS);
}

/**
 * The pool's banked resets: those of the accounts in it, each still clearing its own windows.
 * Null when no account's are known. A reset banked on any account means the pool may run out
 * early and be refilled, as a reset banked on one login does. Before a reset expires only its
 * own account has to be filled (`fill`, in points of the pool), not the whole pool.
 */
export function poolBanked(pool: HubPool): Banked | null {
  const members = pool.accounts.filter(inPool);
  const known = members.filter((a) => a.banked !== null);
  const count = known.reduce((sum, a) => sum + (a.banked?.count ?? 0), 0);
  if (known.length === 0 || (count === 0 && known.length < members.length)) {
    return null; // none known, or none on the accounts read while another's are unknown
  }
  const total = (window: string) =>
    members.filter((a) => limitedBy(a, window)).reduce((sum, a) => sum + capacity(a), 0);
  // the pool's windows and their lengths, from every account that runs them
  const lengths = new Map<string, number>();
  for (const a of members) {
    for (const w of a.windows) {
      lengths.set(w.name, Math.max(lengths.get(w.name) ?? 0, w.lengthS));
    }
  }
  // the windows a reset of this account clears: only those its plan limits
  const clears = (a: HubAccount, c: Credit): string[] | null =>
    a.limits === null
      ? c.clears === null
        ? null
        : [...c.clears]
      : (c.clears ?? [...lengths.keys()]).filter((n) => limitedBy(a, n));
  // the account's room in the longest of those the pool has (a window it has not started is all
  // room), and when that window resets on its own
  const pooled = (a: HubAccount, c: Credit): Credit => {
    const cleared = clears(a, c);
    let longest: string | null = null;
    for (const [name, length] of lengths) {
      if (
        (cleared === null || cleared.includes(name)) &&
        (longest === null || length > (lengths.get(longest) ?? 0))
      ) {
        longest = name;
      }
    }
    const credit = { ...c, clears: cleared };
    if (longest === null) {
      return credit;
    }
    const own = a.windows.find((w) => w.name === longest);
    const fill = (capacity(a) * (100 - (own?.used ?? 0))) / total(longest);
    return own === undefined ? { ...credit, fill } : { ...credit, fill, ownerResetsAt: own.resetsAt };
  };
  return {
    count,
    // a reset whose account lists none is one with its expiry unknown: the count says it is there
    credits: known.flatMap((a) => (a.banked?.credits ?? []).map((c) => pooled(a, c))),
  };
}

/** Why the accounts are out of the pool, such as "claude 1 unreadable (HTTP 401), claude 2 disabled". */
function accountStates(accounts: readonly HubAccount[]): string {
  return accounts
    .map((a) => {
      if (a.state === "ok") {
        return `${a.label} has weight ${a.weight}`;
      }
      return a.detail ? `${a.label} ${a.state} (${a.detail})` : `${a.label} ${a.state}`;
    })
    .join(", ");
}

/**
 * Who is in the pool and with what share, as text: when it changes, the pool's use moves by
 * more than any burn, so its history starts over.
 */
export function poolMembers(pool: HubPool): string {
  // an account read again after standing in with an older reading moves the pool at once too
  return (
    pool.accounts
      .filter(inPool)
      // and so does one whose plan gains or loses a window's limit
      .map(
        (a) =>
          `${a.label}\u0000${capacity(a)}\u0000${a.detail === null ? "fresh" : "stale"}` +
          `\u0000${a.limits === null ? "" : a.limits.join(",")}`,
      )
      .sort()
      .join("\n")
  );
}

/** The pool as the reading's line names it: "claude pool (3 accounts)", "codex pool (1 of 2 accounts)". */
export function poolName(source: Source, pool: HubPool): string {
  const read = pool.accounts.filter(inPool).length;
  const all = enabled(pool).length;
  const counted = read === all ? `${all} account${all === 1 ? "" : "s"}` : `${read} of ${all} accounts`;
  return `${source} pool (${counted})`;
}
