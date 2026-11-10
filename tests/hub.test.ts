// A CLIProxyAPI auth hub: `agent-pace hub serve` against a fake management API, and clients
// whose Claude Code or Codex goes through the hub reading the pool from it. Nothing here
// touches the network: the management API, the hub's tailnet address and the providers are
// all answered in the test.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USAGE_URL } from "../src/claude.ts";
import { main } from "../src/cli.ts";
import { CODEX_RESET_CREDITS_URL, CODEX_USAGE_URL } from "../src/codex.ts";
import type { Host } from "../src/host.ts";
import { HUB_CACHE_S, hubHandler, parseHubArgs, startHub } from "../src/hub-serve.ts";
import { Case, type Fields, iso, NOW } from "./harness.ts";

setDefaultTimeout(30_000);

const HUB = "https://hub.test:8317";
const ACCESS_KEY = "sk-access-for-tests";
const MANAGEMENT_KEY = "management-for-tests";

/** The accounts CLIProxyAPI lists, in its order (by file name). */
const AUTH_FILES: Fields[] = [
  {
    id: "claude-alice@example.com.json",
    auth_index: "a1",
    name: "claude-alice@example.com.json",
    provider: "claude",
    label: "alice@example.com",
    email: "alice@example.com",
    disabled: false,
    unavailable: false,
    note: "work",
    weight: 3,
  },
  {
    id: "claude-bob@example.com.json",
    auth_index: "b2",
    name: "claude-bob@example.com.json",
    provider: "claude",
    email: "bob@example.com",
    disabled: false,
    unavailable: true,
  },
  {
    id: "claude-carol.json",
    auth_index: "c3",
    name: "claude-carol.json",
    provider: "claude",
    disabled: true,
  },
  { id: "claude-dave.json", auth_index: "d4", name: "claude-dave.json", provider: "claude", disabled: false },
  {
    id: "codex-erin.json",
    auth_index: "e5",
    name: "codex-erin.json",
    provider: "codex",
    disabled: false,
    id_token: { chatgpt_account_id: "acct-e", plan_type: "pro" },
  },
  {
    id: "codex-frank.json",
    auth_index: "f6",
    name: "codex-frank.json",
    provider: "codex",
    disabled: false,
    weight: 2,
    id_token: { chatgpt_account_id: "acct-f", plan_type: "promax" },
  },
  { id: "gemini.json", auth_index: "g7", name: "gemini.json", provider: "gemini-cli", disabled: false },
];

/** What each account's upstream answers: [status, body] by auth_index and URL. */
function upstreamAnswers(): Record<string, Record<string, [number, unknown]>> {
  return {
    a1: {
      [USAGE_URL]: [
        200,
        {
          five_hour: { utilization: 40, resets_at: iso(NOW + 7200) },
          seven_day: { utilization: 60, resets_at: iso(NOW + 3 * 86400) },
          cedar_ember: {
            eligible: true,
            grants: [
              {
                label: "One usage-limit reset",
                type: "full",
                resets_left: 1,
                ends_at: iso(NOW + 2 * 86400),
                clears: ["five_hour", "seven_day"],
                paused: false,
              },
            ],
          },
        },
      ],
    },
    b2: {
      [USAGE_URL]: [
        200,
        {
          five_hour: { utilization: 100, resets_at: iso(NOW + 3600) },
          seven_day: { utilization: 80, resets_at: iso(NOW + 5 * 86400) },
        },
      ],
    },
    d4: { [USAGE_URL]: [401, { error: { message: "token sk-ant-should-never-show" } }] },
    e5: {
      [CODEX_USAGE_URL]: [
        200,
        {
          plan_type: "pro",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 30,
              limit_window_seconds: 18000,
              reset_after_seconds: 3600,
              reset_at: NOW + 3600,
            },
            secondary_window: {
              used_percent: 50,
              limit_window_seconds: 604800,
              reset_after_seconds: 2 * 86400,
              reset_at: NOW + 2 * 86400,
            },
          },
          rate_limit_reset_credits: { available_count: 1 },
        },
      ],
      [CODEX_RESET_CREDITS_URL]: [
        200,
        {
          available_count: 1,
          credits: [
            {
              id: "c1",
              reset_type: "codex_rate_limits",
              status: "available",
              granted_at: iso(NOW - 86400),
              expires_at: iso(NOW + 86400),
              title: "Full reset",
            },
            {
              id: "c0",
              reset_type: "codex_rate_limits",
              status: "redeemed",
              granted_at: iso(NOW - 9 * 86400),
              expires_at: iso(NOW - 86400),
              title: "Full reset",
            },
          ],
        },
      ],
    },
    f6: {
      [CODEX_USAGE_URL]: [
        200,
        {
          plan_type: "promax",
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: NOW + 4 * 3600 },
            secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: NOW + 6 * 86400 },
          },
          rate_limit_reset_credits: { available_count: 0 },
        },
      ],
    },
  };
}

/** A CLIProxyAPI management API on 127.0.0.1:8317, as fetch sees it, recording each call. */
class FakeCliproxy {
  files: Fields[] = AUTH_FILES.map((f) => ({ ...f }));
  answers = upstreamAnswers();
  listStatus = 200;
  /** The Retry-After the upstream sends with a 429, as api-call reports it. */
  retryAfter: string | null = null;
  readonly calls: { path: string; authorization: string | null; body: Fields | null }[] = [];

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const authorization = new Headers(init.headers).get("authorization");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Fields) : null;
    this.calls.push({ path: parsed.pathname, authorization, body });
    if (parsed.host !== "127.0.0.1:8317") {
      throw new Error(`the service called ${parsed.host}`);
    }
    if (authorization !== `Bearer ${MANAGEMENT_KEY}`) {
      return new Response('{"error":"invalid management key"}', { status: 401 });
    }
    if (parsed.pathname === "/v0/management/auth-files" && (init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ files: this.files }), { status: this.listStatus });
    }
    if (parsed.pathname === "/v0/management/api-call" && init.method === "POST" && body) {
      const [status, answer] = this.answers[String(body.auth_index)]?.[String(body.url)] ?? [404, {}];
      const header = status === 429 && this.retryAfter ? { "Retry-After": [this.retryAfter] } : {};
      return new Response(JSON.stringify({ status_code: status, header, body: JSON.stringify(answer) }));
    }
    return new Response("{}", { status: 404 });
  };

  upstreamCalls(): Fields[] {
    return this.calls.flatMap((c) => (c.body ? [c.body] : []));
  }
}

let c: Case;
let cliproxy: FakeCliproxy;
let mono: number;
let serviceErr: string;

/** The hub's key files: one key in each. */
function writeKeys(dir: string): string {
  const keys = join(dir, "hub-keys");
  mkdirSync(keys, { recursive: true });
  writeFileSync(join(keys, "access-key"), `${ACCESS_KEY}\n`);
  writeFileSync(join(keys, "management-key"), `${MANAGEMENT_KEY}\n`);
  return keys;
}

/** The service's host: the case's machine with the fake management API and a clock we move. */
function serviceHost(): Host {
  return {
    ...c.host(),
    monotonic: () => mono,
    fetch: cliproxy.fetch,
    stderr: (text) => {
      serviceErr += text;
    },
  };
}

function service() {
  const keys = writeKeys(c.dir);
  return hubHandler(
    { port: 8318, keys, cliproxy: "http://127.0.0.1:8317", state: join(c.dir, "hub-state") },
    serviceHost(),
  );
}

const get = (path: string, key: string | null = ACCESS_KEY, method = "GET") =>
  new Request(`http://127.0.0.1:8318${path}`, {
    method,
    headers: key === null ? {} : { Authorization: `Bearer ${key}` },
  });

/** Sends the case's hub requests to the service, with the mount path stripped as tailscale serve does. */
function connect(): void {
  const handle = service();
  c.hubFetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (!path.startsWith("/agent-pace/")) {
      return new Response("", { status: 404 }); // CLIProxyAPI's own routes
    }
    return handle(new Request(`http://127.0.0.1:8318${path.slice("/agent-pace".length)}`, init));
  };
}

function claudeClient(env: Fields = { ANTHROPIC_BASE_URL: HUB, ANTHROPIC_AUTH_TOKEN: ACCESS_KEY }): void {
  mkdirSync(c.env.CLAUDE_CONFIG_DIR as string, { recursive: true });
  writeFileSync(
    join(c.env.CLAUDE_CONFIG_DIR as string, "settings.json"),
    JSON.stringify({ model: "opus", env }),
  );
}

function codexClient(url = `${HUB}/v1`, key = ACCESS_KEY): void {
  writeFileSync(
    join(c.env.CODEX_HOME as string, "config.toml"),
    [
      "# BEGIN cliproxy-hub:provider",
      'model_provider = "cliproxy"',
      "# END cliproxy-hub:provider",
      'model = "gpt-6.1-sol"',
      "",
      "# BEGIN cliproxy-hub:table",
      "[model_providers.cliproxy]",
      'name = "CLIProxyAPI"',
      `base_url = "${url}"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = true",
      `experimental_bearer_token = "${key}"`,
      "# END cliproxy-hub:table",
      "",
    ].join("\n"),
  );
}

beforeEach(() => {
  c = new Case();
  c.currentDefaults = true;
  cliproxy = new FakeCliproxy();
  mono = 1000;
  serviceErr = "";
});

afterEach(() => {
  c.cleanup();
});

describe("HubService", () => {
  test("each Claude account's windows and banked resets, read with the account's own login", async () => {
    const response = await service()(get("/v1/usage/claude"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      version: 1,
      provider: "claude",
      observed_at: NOW,
      accounts: [
        {
          label: "work",
          plan: null,
          weight: 3,
          cooling_down: false,
          state: "ok",
          detail: null,
          read_at: NOW,
          windows: [
            { name: "5h", used: 40, resets_at: NOW + 7200, length_s: 18000 },
            { name: "7d", used: 60, resets_at: NOW + 3 * 86400, length_s: 604800 },
          ],
          banked: {
            count: 1,
            credits: [{ expires_at: NOW + 2 * 86400, title: "One usage-limit reset", clears: ["5h", "7d"] }],
          },
        },
        {
          label: "claude 2",
          plan: null,
          weight: null,
          cooling_down: true,
          state: "ok",
          detail: null,
          read_at: NOW,
          windows: [
            { name: "5h", used: 100, resets_at: NOW + 3600, length_s: 18000 },
            { name: "7d", used: 80, resets_at: NOW + 5 * 86400, length_s: 604800 },
          ],
          banked: null,
        },
        {
          label: "claude 3",
          plan: null,
          weight: null,
          cooling_down: false,
          state: "disabled",
          detail: null,
          read_at: null,
          windows: [],
          banked: null,
        },
        {
          label: "claude 4",
          plan: null,
          weight: null,
          cooling_down: false,
          state: "unreadable",
          detail: "HTTP 401",
          read_at: null,
          windows: [],
          banked: null,
        },
      ],
    });
    // one GET per enabled account, to the endpoint Claude Code's /usage reads, the token left to the hub
    expect(cliproxy.upstreamCalls()).toEqual(
      ["a1", "b2", "d4"].map((index) => ({
        auth_index: index,
        method: "GET",
        url: USAGE_URL,
        header: {
          Authorization: "Bearer $TOKEN$",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-cli/2.1.999 (external, cli)",
          "x-app": "cli",
        },
      })),
    );
  });

  test("Codex accounts carry their plan, weight and banked resets", async () => {
    const body = (await (await service()(get("/v1/usage/codex"))).json()) as Fields;
    expect(body.accounts).toEqual([
      {
        label: "codex 1",
        plan: "pro",
        weight: null,
        cooling_down: false,
        state: "ok",
        detail: null,
        read_at: NOW,
        windows: [
          { name: "5h", used: 30, resets_at: NOW + 3600, length_s: 18000 },
          { name: "7d", used: 50, resets_at: NOW + 2 * 86400, length_s: 604800 },
        ],
        banked: { count: 1, credits: [{ expires_at: NOW + 86400, title: "Full reset", clears: null }] },
      },
      {
        label: "codex 2",
        plan: "promax",
        weight: 2,
        cooling_down: false,
        state: "ok",
        detail: null,
        read_at: NOW,
        windows: [
          { name: "5h", used: 10, resets_at: NOW + 4 * 3600, length_s: 18000 },
          { name: "7d", used: 20, resets_at: NOW + 6 * 86400, length_s: 604800 },
        ],
        banked: { count: 0, credits: [] },
      },
    ]);
    // the reset list only for the account the usage says has some; every call a GET
    expect(cliproxy.upstreamCalls().map((b) => [b.auth_index, b.method, b.url])).toEqual([
      ["e5", "GET", CODEX_USAGE_URL],
      ["f6", "GET", CODEX_USAGE_URL],
      ["e5", "GET", CODEX_RESET_CREDITS_URL],
    ]);
    const first = cliproxy.upstreamCalls()[0] ?? {};
    expect((first.header as Fields)["Chatgpt-Account-Id"]).toBe("acct-e");
  });

  test("no token, email or upstream body reaches the answer", async () => {
    const text = await (await service()(get("/v1/usage/claude"))).text();
    for (const secret of [MANAGEMENT_KEY, ACCESS_KEY, "example.com", "sk-ant-should-never-show", "$TOKEN$"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("the answer's keys come in a fixed order", async () => {
    const text = await (await service()(get("/v1/usage/claude"))).text();
    expect(text).toStartWith(
      `{"version": 1, "provider": "claude", "observed_at": ${NOW}.0, "accounts": [{"label": "work", ` +
        `"plan": null, "weight": 3, "cooling_down": false, "state": "ok", "detail": null, "read_at": ${NOW}.0, ` +
        `"windows": [{"name": "5h", "used": 40.0, "resets_at": ${NOW + 7200}.0, "length_s": 18000}, `,
    );
  });

  test("no ChatGPT account id or email reaches a Codex answer", async () => {
    const response = await service()(get("/v1/usage/codex"));
    expect(response.headers.get("x-agent-pace-hub")).toBe("1");
    const text = await response.text();
    for (const secret of ["acct-e", "acct-f", "codex-erin", MANAGEMENT_KEY, "$TOKEN$"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("an email address as a note does not name the account", async () => {
    (cliproxy.files[0] as Fields).note = "alice@example.com";
    const body = (await (await service()(get("/v1/usage/claude"))).json()) as Fields;
    expect((body.accounts as Fields[])[0]?.label).toBe("claude 1");
  });

  test("a 429 leaves the account alone as long as it asks, with its last reading standing in", async () => {
    const handle = service();
    await handle(get("/v1/usage/claude"));
    const answers = cliproxy.answers.a1 as Record<string, [number, unknown]>;
    const good = answers[USAGE_URL] as [number, unknown];
    answers[USAGE_URL] = [429, {}];
    cliproxy.retryAfter = "1200";
    const callsTo = (index: string) => cliproxy.upstreamCalls().filter((b) => b.auth_index === index).length;
    // a minute later: asked once, answered 429; its last reading stands in, with why
    mono += HUB_CACHE_S + 1;
    c.clock = NOW + 61;
    let body = (await (await handle(get("/v1/usage/claude"))).json()) as Fields;
    let work = (body.accounts as Fields[])[0] as Fields;
    expect([work.state, work.detail, work.read_at, (work.windows as Fields[]).length]).toEqual([
      "ok",
      "HTTP 429",
      NOW,
      2,
    ]);
    expect(callsTo("a1")).toBe(2);
    // within its Retry-After it is not asked again, the others are
    mono += HUB_CACHE_S + 1;
    c.clock = NOW + 600;
    body = (await (await handle(get("/v1/usage/claude"))).json()) as Fields;
    expect(callsTo("a1")).toBe(2);
    expect(callsTo("b2")).toBe(3);
    // after it, it is asked again and read
    answers[USAGE_URL] = good;
    mono += HUB_CACHE_S + 1;
    c.clock = NOW + 61 + 1200;
    body = (await (await handle(get("/v1/usage/claude"))).json()) as Fields;
    work = (body.accounts as Fields[])[0] as Fields;
    expect([callsTo("a1"), work.detail, work.read_at]).toEqual([3, null, NOW + 61 + 1200]);
  });

  test("a last reading older than half an hour is no reading, and windows that reset since are dropped", async () => {
    const handle = service();
    await handle(get("/v1/usage/claude"));
    const answers = cliproxy.answers.b2 as Record<string, [number, unknown]>;
    answers[USAGE_URL] = [500, {}];
    mono += HUB_CACHE_S + 1;
    c.clock = NOW + 3601; // claude 2's 5h window reset an hour after NOW
    let body = (await (await handle(get("/v1/usage/claude"))).json()) as Fields;
    let bob = (body.accounts as Fields[])[1] as Fields;
    expect([bob.state, bob.detail, (bob.windows as Fields[]).map((w) => w.name)]).toEqual([
      "unreadable",
      "HTTP 500",
      [],
    ]);
    // read again fresh: a failure ten minutes later keeps it, without the 5h window that has reset
    answers[USAGE_URL] = upstreamAnswers().b2?.[USAGE_URL] as [number, unknown];
    mono += HUB_CACHE_S + 1;
    c.clock = NOW + 2000;
    await handle(get("/v1/usage/claude"));
    answers[USAGE_URL] = [500, {}];
    mono += HUB_CACHE_S + 1;
    c.clock = NOW + 3601;
    body = (await (await handle(get("/v1/usage/claude"))).json()) as Fields;
    bob = (body.accounts as Fields[])[1] as Fields;
    expect([bob.state, (bob.windows as Fields[]).map((w) => w.name)]).toEqual(["ok", ["7d"]]);
  });

  test("/v1/hub says it is the service, behind the access key, without reading any account", async () => {
    const handle = service();
    expect((await handle(get("/agent-pace/v1/hub", null))).status).toBe(401);
    const hello = await handle(get("/agent-pace/v1/hub"));
    expect([hello.status, hello.headers.get("x-agent-pace-hub"), await hello.text()]).toEqual([
      200,
      "1",
      '{"version": 1}\n',
    ]);
    expect(cliproxy.calls).toEqual([]);
  });

  test("without the access key, or with another, nothing is read", async () => {
    const handle = service();
    for (const key of [null, "sk-wrong", `${ACCESS_KEY}x`, MANAGEMENT_KEY]) {
      const response = await handle(get("/v1/usage/claude", key));
      expect([response.status, response.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);
    }
    expect(cliproxy.calls).toEqual([]);
  });

  test("the tailnet path, other paths and other methods", async () => {
    const handle = service();
    expect((await handle(get("/agent-pace/v1/usage/codex"))).status).toBe(200);
    expect((await handle(get("/v1/usage/gemini"))).status).toBe(404);
    expect((await handle(get("/v0/management/auth-files"))).status).toBe(404);
    const post = await handle(get("/v1/usage/claude", ACCESS_KEY, "POST"));
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
  });

  test("a provider is read upstream at most once a minute, however many ask", async () => {
    const handle = service();
    await Promise.all([handle(get("/v1/usage/claude")), handle(get("/v1/usage/claude"))]);
    await handle(get("/v1/usage/claude"));
    expect(cliproxy.calls.filter((x) => x.path.endsWith("auth-files"))).toHaveLength(1);
    mono += HUB_CACHE_S + 1;
    await handle(get("/v1/usage/claude"));
    expect(cliproxy.calls.filter((x) => x.path.endsWith("auth-files"))).toHaveLength(2);
  });

  test("a management API that fails is reported and not remembered", async () => {
    const handle = service();
    cliproxy.listStatus = 500;
    const failed = await handle(get("/v1/usage/claude"));
    expect([failed.status, await failed.json()]).toEqual([
      502,
      { error: "CLIProxyAPI's management API answered HTTP 500" },
    ]);
    expect(serviceErr).toBe("agent-pace hub: claude: CLIProxyAPI's management API answered HTTP 500\n");
    cliproxy.listStatus = 200;
    expect((await handle(get("/v1/usage/claude"))).status).toBe(200);
  });

  test("without its key files it answers 503 and calls nothing", async () => {
    const handle = hubHandler(
      { port: 8318, keys: join(c.dir, "missing"), cliproxy: "http://127.0.0.1:8317", state: c.state },
      serviceHost(),
    );
    const response = await handle(get("/v1/usage/claude"));
    expect([response.status, await response.json()]).toEqual([
      503,
      { error: "the hub's access-key file cannot be read" },
    ]);
    expect(cliproxy.calls).toEqual([]);
  });
});

describe("HubServeListener", () => {
  test("it listens on 127.0.0.1 only", () => {
    const keys = writeKeys(c.dir);
    const server = startHub(
      { port: 0, keys, cliproxy: "http://127.0.0.1:8317", state: c.state },
      serviceHost(),
    );
    try {
      expect(server.hostname).toBe("127.0.0.1");
    } finally {
      server.stop(true);
    }
  });
});

describe("HubServeArguments", () => {
  test("defaults beside CLIProxyAPI", () => {
    expect(parseHubArgs(["serve"], c.host())).toEqual({
      kind: "serve",
      options: {
        port: 8318,
        keys: join(c.dir, ".config", "cliproxyapi"),
        cliproxy: "http://127.0.0.1:8317",
        state: join(c.dir, ".local", "state", "agent-pace"),
      },
    });
  });

  test("the management key is only sent to this machine", () => {
    expect(parseHubArgs(["serve", "--cliproxy", "https://hub.example.com:8317"], c.host())).toEqual({
      kind: "error",
      message: "argument --cliproxy: must be CLIProxyAPI on this machine (127.0.0.1, localhost or [::1])",
    });
  });

  test("usage errors and help", async () => {
    expect(parseHubArgs([], c.host())).toEqual({
      kind: "error",
      message: "the following arguments are required: serve",
    });
    expect(await c.runPace("hub", "server")).toEqual([
      "",
      "usage: agent-pace hub serve [-h] [--port PORT] [--keys DIR] [--cliproxy URL] [--state DIR]\n" +
        "agent-pace hub: error: invalid choice: 'server' (choose from 'serve')\n",
    ]);
    expect(c.status).toBe(2);
    const [help] = await c.runPace("hub", "serve", "--help");
    expect(help).toStartWith("usage: agent-pace hub serve [-h] [--port PORT]");
    expect(c.status).toBe(0);
    expect(parseHubArgs(["serve", "--port", "70000"], c.host())).toEqual({
      kind: "error",
      message: "argument --port: not a port: '70000'",
    });
  });

  test("agent-pace hub with nothing after it is a usage error; claude-pace hub is the source's error as before", async () => {
    let err = "";
    const host = {
      ...c.host(),
      stderr: (text: string) => {
        err += text;
      },
    };
    expect(await main(["hub"], "agent-pace", host)).toBe(2);
    expect(err).toEndWith("agent-pace hub: error: the following arguments are required: serve\n");
    const [, sourceErr] = await c.runAs("claude-pace", "hub");
    expect([sourceErr.split("\n").at(-2), c.status]).toEqual([
      "claude-pace: error: unrecognized arguments: hub",
      2,
    ]);
  });

  test("the sources' own help is unchanged: hub is not one of them", async () => {
    const [help] = await c.runPace("--help");
    expect(help).toContain("{claude,codex,plan}");
    expect(help).not.toContain("hub");
  });
});

describe("HubClient", () => {
  test("Claude Code through the hub: the pool, then each account", async () => {
    connect();
    claudeClient();
    const [out, err] = await c.runPace("claude");
    expect(err).toBe("");
    expect(out).toBe(
      "12:25 claude pool (2 of 3 accounts): 5h 55% ? 1.75h left (25.7%/h lands on 100.0%) -> measuring | " +
        "7d 65% 0.8%/h (window avg) 84.0h left, runs out in ~43.8h (0.4%/h lands on 100.0%) -> slow down\n" +
        "  work (weight 3): 5h 40% resets Wed 22 Oct 14:25 (in 2.0h) | 7d 60% resets Sat 25 Oct 12:25 (in 72.0h); " +
        "1 banked, next expires Fri 24 Oct 12:25\n" +
        "  claude 2: 5h 100% resets Wed 22 Oct 13:25 (in 1.0h) | 7d 80% resets Mon 27 Oct 11:25 (in 120.0h); " +
        "cooling down on the hub\n" +
        "  claude 3: disabled on the hub, not in the pool\n" +
        "  claude 4: unreadable (HTTP 401), left out of the pool\n",
    );
    // the leftover local login (CLAUDE_CODE_OAUTH_TOKEN) is never read
    expect(c.requests.map((r) => r.url)).toEqual([
      `${HUB}/agent-pace/v1/hub`,
      `${HUB}/agent-pace/v1/usage/claude`,
    ]);
    expect(c.requests[0]?.headers.get("authorization")).toBe(`Bearer ${ACCESS_KEY}`);
    // the pool keeps its own history, beside the local login's
    expect(readFileSync(join(c.state, "claude-pool-5h.csv"), "utf8")).toBe(`${NOW},55.0,${NOW + 6300}\r\n`);
    expect(existsSync(join(c.state, "claude-5h.csv"))).toBe(false);
  });

  test("Codex through the hub: no app server, no session logs", async () => {
    connect();
    codexClient();
    c.sessionLog(99);
    const [out, err] = await c.runPace("codex");
    expect(err).toBe("");
    expect(out.split("\n").slice(1)).toEqual([
      "  codex 1 (pro): 5h 30% resets Wed 22 Oct 13:25 (in 1.0h) | 7d 50% resets Fri 24 Oct 12:25 (in 48.0h); " +
        "1 banked, next expires Thu 23 Oct 12:25",
      "  codex 2 (promax, weight 2): 5h 10% resets Wed 22 Oct 16:25 (in 4.0h) | 7d 20% resets Tue 28 Oct 11:25 (in 144.0h)",
      "",
    ]);
    expect(out).toStartWith("12:25 codex pool (2 accounts): 5h 17% ");
    expect(existsSync(c.paths.log)).toBe(false); // codex app-server never started
  });

  test("--json: the pool's windows, and each account with its plan, weight and share", async () => {
    connect();
    codexClient();
    const out = await c.json("codex");
    const windows = out.windows as Fields[];
    expect(windows.map((w) => [w.window, w.used, w.resets_at, w.previous_window_ended_at])).toEqual([
      ["5h", 16.67, iso(NOW + (3600 + 2 * 4 * 3600) / 3).replace("Z", "+00:00"), null],
      ["7d", 30.0, iso(NOW + (2 * 86400 + 2 * 6 * 86400) / 3).replace("Z", "+00:00"), null],
    ]);
    expect(out.banked_resets).toEqual({ known: false, count: null, credits: null, via: "hub", note: null });
    const hub = out.hub as Fields;
    expect([hub.url, hub.accounts_in_pool, hub.accounts_enabled, hub.pool_capacity]).toEqual([HUB, 2, 2, 3]);
    expect((hub.accounts as Fields[])[1]).toEqual({
      label: "codex 2",
      plan: "promax",
      weight: 2,
      capacity: 2,
      in_pool: true,
      state: "ok",
      detail: null,
      read_at: iso(NOW).replace("Z", "+00:00"),
      cooling_down: false,
      windows: [
        { window: "5h", used: 10.0, resets_at: iso(NOW + 4 * 3600).replace("Z", "+00:00"), hours_left: 4.0 },
        {
          window: "7d",
          used: 20.0,
          resets_at: iso(NOW + 6 * 86400).replace("Z", "+00:00"),
          hours_left: 144.0,
        },
      ],
      banked_resets: { known: true, count: 0, credits: [] },
    });
  });

  test("the pool is paced by its own history: a pool burning fast slows down", async () => {
    connect();
    claudeClient();
    // the pool's 5h at 43% an hour ago, 49% half an hour ago: 12%/h, to 55 + 12 * 1.75 = 76%
    writeFileSync(
      join(c.state, "claude-pool-5h.csv"),
      `${NOW - 3600},43.0,${NOW + 6300}\r\n${NOW - 1800},49.0,${NOW + 6300}\r\n`,
    );
    c.claudeLanes(2);
    const [out] = await c.runPace("claude");
    expect(out.split("\n")[0]).toStartWith(
      "12:25 claude pool (2 of 3 accounts): 5h 55% 12.0%/h 1.75h left, ends ~76%",
    );
  });

  test("an account's reset is no end of the pool's window", async () => {
    connect();
    claudeClient();
    // the readings before an account reset have another mean reset time
    writeFileSync(join(c.state, "claude-pool-5h.csv"), `${NOW - 600},70.0,${NOW + 3000}\r\n`);
    c.sleeps = 2;
    const [out] = await c.runPace("claude", "--watch");
    expect(out).not.toContain("window reset");
    expect(((await c.json("claude")).windows as Fields[])[0]?.previous_window_ended_at).toBeNull();
  });

  test("plan reads both pools", async () => {
    connect();
    claudeClient();
    codexClient();
    const [out, err] = await c.runPace("plan");
    expect(err).toBe("");
    const lines = out.split("\n");
    expect(lines[1]).toStartWith("  12:25 claude pool (2 of 3 accounts): ");
    expect(lines[2]).toStartWith("    work (weight 3): 5h 40%");
    expect(lines.find((l) => l.startsWith("  12:25 codex pool (2 accounts): "))).toBeDefined();
    expect(lines).toContain(
      "    codex 2 (promax, weight 2): 5h 10% resets Wed 22 Oct 16:25 (in 4.0h) | 7d 20% resets Tue 28 Oct 11:25 (in 144.0h)",
    );
  });

  test("weight 0 leaves an account out of the pool", async () => {
    connect();
    claudeClient();
    (cliproxy.files[0] as Fields).weight = 0;
    const [out] = await c.runPace("claude");
    expect(out).toStartWith("12:25 claude pool (1 of 3 accounts): 5h 100% ");
    expect(out).toContain("  work (weight 0): 5h 40% ");
    expect(out).toContain("; 1 banked, next expires Fri 24 Oct 12:25; weight 0, left out of the pool\n");
  });

  test("no account readable is a failed reading, not the end of a watch", async () => {
    connect();
    claudeClient();
    cliproxy.files = cliproxy.files.filter((f) => f.auth_index === "d4");
    const [out, err] = await c.runPace("claude");
    expect([out, err, c.status]).toEqual([
      "",
      "agent-pace: no Claude account on the hub can be read now (claude 1 unreadable (HTTP 401))\n",
      0,
    ]);
  });

  test("a rejected access key, and a hub without agent-pace", async () => {
    connect();
    claudeClient({ ANTHROPIC_BASE_URL: HUB, ANTHROPIC_AUTH_TOKEN: "sk-stale" });
    const settings = join(c.env.CLAUDE_CONFIG_DIR as string, "settings.json");
    expect(await c.runPace("claude")).toEqual([
      "",
      `agent-pace: the hub at ${HUB} rejected the access key in ${settings}\n`,
    ]);
    expect(c.status).toBe(1);
  });

  test("an address that is no agent-pace hub (a gateway, a hub without the service) reads this machine as before", async () => {
    c.hubFetch = async () => new Response("", { status: 404 }); // no x-agent-pace-hub header
    claudeClient();
    const [out, err] = await c.runPace("claude");
    expect(err).toBe("");
    expect(out).toStartWith("12:25 claude: 5h 6% ");
    expect(c.requests.map((r) => r.url)).toEqual([`${HUB}/agent-pace/v1/hub`, USAGE_URL]);
    c.hubFetch = async () => new Response('{"detail": "Not Found"}', { status: 401 });
    expect((await c.runPace("claude"))[0]).toStartWith("12:25 claude: 5h 6% ");
  });

  test("the access key is never sent over plain http to another machine", async () => {
    claudeClient({ ANTHROPIC_BASE_URL: "http://hub.test:8317", ANTHROPIC_AUTH_TOKEN: ACCESS_KEY });
    const [out] = await c.runPace("claude");
    expect(out).toStartWith("12:25 claude: 5h 6% ");
    expect(c.requests.map((r) => r.url)).toEqual([USAGE_URL]);
  });

  test("settings without the hub's two entries read this machine's own login, as before", async () => {
    claudeClient({ ANTHROPIC_BASE_URL: HUB }); // no token: not a hub client
    const [out] = await c.runPace("claude");
    expect(out).toStartWith("12:25 claude: 5h 6% ");
    expect(c.requests.map((r) => r.url)).toEqual([USAGE_URL]);
  });

  test("a Codex config with another provider reads Codex as before", async () => {
    writeFileSync(join(c.env.CODEX_HOME as string, "config.toml"), 'model_provider = "openai"\n');
    const [out] = await c.runPace("codex");
    expect(out).toStartWith("12:25 codex: 7d 68% ");
  });

  test("a Codex provider with its key in env_key, and one with no key at all", async () => {
    connect();
    const config = join(c.env.CODEX_HOME as string, "config.toml");
    writeFileSync(
      config,
      `model_provider = "cliproxy"\n[model_providers.cliproxy]\nbase_url = "${HUB}/v1"\nenv_key = "HUB_KEY"\n`,
    );
    c.env.HUB_KEY = ACCESS_KEY;
    expect((await c.runPace("codex"))[0]).toStartWith("12:25 codex pool (2 accounts): ");
    delete c.env.HUB_KEY;
    const [out] = await c.runPace("codex"); // nothing to ask the hub with: Codex as before
    expect(out).toStartWith("12:25 codex: 7d 68% ");
  });

  test("an account leaving the pool starts the pool's history over, not a burst of burn", async () => {
    connect();
    claudeClient();
    c.clock = NOW - 120;
    await c.runPace("claude");
    // claude 2 becomes unreadable on a hub that has no last reading of it (just restarted)
    const answers = cliproxy.answers.b2 as Record<string, [number, unknown]>;
    answers[USAGE_URL] = [500, {}];
    connect();
    c.clock = NOW;
    const [out] = await c.runPace("claude");
    expect(out).toStartWith("12:25 claude pool (1 of 3 accounts): 5h 40% ? ");
    expect(readFileSync(join(c.state, "claude-pool-5h.csv"), "utf8")).toBe(`${NOW},40.0,${NOW + 7200}\r\n`);
    expect(readFileSync(join(c.state, "claude-pool-members"), "utf8")).toBe("work\u00003\u0000fresh");
  });

  test("an account standing in with an older reading, and read again, starts the history over each time", async () => {
    const handle = service();
    c.hubFetch = async (url, init) =>
      handle(new Request(`http://127.0.0.1:8318${new URL(url).pathname.slice("/agent-pace".length)}`, init));
    claudeClient();
    await c.runPace("claude");
    const answers = cliproxy.answers.a1 as Record<string, [number, unknown]>;
    const good = answers[USAGE_URL] as [number, unknown];
    answers[USAGE_URL] = [500, {}];
    mono += HUB_CACHE_S + 1;
    c.clock = NOW + 120;
    const [out] = await c.runPace("claude");
    expect(out).toContain("  work (weight 3): 5h 40% ");
    expect(out).toContain("; as read Wed 22 Oct 12:25 (now HTTP 500); ");
    expect(readFileSync(join(c.state, "claude-pool-members"), "utf8")).toContain("work\u00003\u0000stale");
    expect(readFileSync(join(c.state, "claude-pool-5h.csv"), "utf8").split("\r\n")).toHaveLength(2);
    answers[USAGE_URL] = good;
    mono += HUB_CACHE_S + 1;
    c.clock = NOW + 240;
    await c.runPace("claude");
    expect(readFileSync(join(c.state, "claude-pool-members"), "utf8")).toContain("work\u00003\u0000fresh");
    expect(readFileSync(join(c.state, "claude-pool-5h.csv"), "utf8").split("\r\n")).toHaveLength(2);
  });

  test("a hub met for the first time is known before its accounts are read", async () => {
    connect();
    claudeClient();
    const usage = c.hubFetch as (url: string, init: RequestInit) => Promise<Response>;
    // the accounts cannot be read yet, but the hub has said it is one: no fallback to this machine
    c.hubFetch = async (url, init) =>
      url.endsWith("/v1/hub") ? usage(url, init) : Promise.reject(new Error("still reading upstream"));
    const [out, err] = await c.runPace("claude");
    expect(out).toBe("");
    expect(err).toStartWith("agent-pace: <urlopen error ");
    expect(readFileSync(join(c.state, "claude-pool-hub"), "utf8")).toBe(HUB);
    expect(c.requests.map((r) => r.url)).not.toContain(USAGE_URL);
  });

  test("a hub that answers /v1/hub with an error is still the hub", async () => {
    claudeClient();
    c.hubFetch = async () =>
      new Response('{"error": "the hub\'s access-key file cannot be read"}\n', {
        status: 503,
        headers: { "x-agent-pace-hub": "1" },
      });
    expect(await c.runPace("claude")).toEqual([
      "",
      "agent-pace: the hub: the hub's access-key file cannot be read\n",
    ]);
    expect(c.requests.map((r) => r.url)).toEqual([
      `${HUB}/agent-pace/v1/hub`,
      `${HUB}/agent-pace/v1/usage/claude`,
    ]);
  });

  test("once an address has answered as a hub, a missing service is a failed reading, not this machine's login", async () => {
    connect();
    claudeClient();
    await c.runPace("claude");
    expect(readFileSync(join(c.state, "claude-pool-hub"), "utf8")).toBe(HUB);
    c.hubFetch = async () => new Response("Bad Gateway", { status: 502 });
    expect(await c.runPace("claude")).toEqual([
      "",
      `agent-pace: the hub at ${HUB} answered without its agent-pace service (HTTP 502); ` +
        `if it no longer runs one, remove ${join(c.state, "claude-pool-hub")}\n`,
    ]);
    c.hubFetch = async () => {
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    };
    expect((await c.runPace("claude"))[1]).toBe(
      "agent-pace: <urlopen error [Errno 61] Connection refused>\n",
    );
    expect(c.requests.map((r) => r.url)).not.toContain(USAGE_URL);
  });

  test("an address that never answered as a hub and cannot be reached reads this machine as before", async () => {
    claudeClient(); // a local router or a gateway that is not running
    c.hubFetch = async () => {
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    };
    const [out, err] = await c.runPace("claude");
    expect([err, out.split(" (")[0]]).toEqual(["", "12:25 claude: 5h 6% ? 1.17h left"]);
    expect(c.requests.map((r) => r.url)).toEqual([`${HUB}/agent-pace/v1/hub`, USAGE_URL]);
  });

  test("--json's hub keys come in a fixed order", async () => {
    connect();
    codexClient();
    const [out] = await c.runPace("codex", "--json");
    const hub = out.slice(out.indexOf('"hub": '));
    expect(hub).toStartWith(
      `"hub": {"url": "${HUB}", "observed_at": "${iso(NOW).replace("Z", "+00:00")}", "accounts_in_pool": 2, ` +
        `"accounts_enabled": 2, "pool_capacity": 3, "accounts": [{"label": "codex 1", "plan": "pro", "weight": null, ` +
        `"capacity": 1, "in_pool": true, "state": "ok", "detail": null, "read_at": "${iso(NOW).replace("Z", "+00:00")}", ` +
        `"cooling_down": false, "windows": [{"window": "5h", "used": 30.0, `,
    );
  });
});
