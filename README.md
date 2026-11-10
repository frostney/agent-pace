# agent-pace

agent-pace paces AI coding-agent work against your plan's usage windows. It reads Claude Code's
5-hour and 7-day windows and Codex's windows, projects each one at its reset, counts the banked
resets on your account, and says how many more agent lanes the headroom supports. Once a
window is at its limit, that headroom is the usage credits you bought, paced against what is
left of them. It only advises: it never redeems a reset or buys credits.

```console
$ agent-pace plan
route spare work to Codex: banked reset expires in 36h and cannot be filled by then (needs 2.4%/h, peak 0.7%/h); fill what you can, then redeem it (lanes: Codex room for ~264 more lanes at 0.3%/h each for 1.0h; Claude measuring: start at most 1-2 new lanes)
  12:25 claude: 5h 6% ? 1.17h left (80.6%/h lands on 100.0%) -> measuring | 7d 40% 0.6%/h (window avg) 96.0h left, ends ~93% (0.6%/h lands on 100.0%) -> room left: add work (measuring: start at most 1-2 new lanes)
  12:25 codex: 7d 20% 0.7%/h (window avg) 139.81h left, runs out in ~4.8d (2.4%/h lands on 100%) -> room left: add work (room for ~264 more lanes at 0.3%/h each for 1.0h)
    banked reset expires Fri 24 Oct 00:10 (in 35.8h): cannot reach 100% by then (needs 2.4%/h, peak seen 0.7%/h); redeem it anyway by Thu 23 Oct 22:10, an unused reset is lost [3 banked]
```

## Install

Each [release](https://github.com/frostney/agent-pace/releases) has a standalone binary for
macOS and Linux (arm64 and x64), with `claude-pace` and `codex-pace` links beside it:

```sh
version=5.1.0 target=darwin-arm64   # or darwin-x64, linux-x64, linux-arm64
curl -fsSL "https://github.com/frostney/agent-pace/releases/download/v$version/agent-pace-$version-$target.tar.gz" \
  | tar -xz -C ~/.local/bin --strip-components=1 \
      "agent-pace-$version-$target/agent-pace" \
      "agent-pace-$version-$target/claude-pace" \
      "agent-pace-$version-$target/codex-pace"
```

Each release also has the bare binary, gzipped, as `agent-pace-<version>-<target>.gz`, for
installers that place one file. `SHA256SUMS` lists the checksums of both.

With [Bun](https://bun.com) installed, `bun install -g github:frostney/agent-pace` runs it from
source instead. Bun drops the first `--` from a script's arguments, so `agent-pace -- claude`
behaves differently there; the binary keeps it.

## Use

```sh
agent-pace claude                          # one reading with advice
agent-pace codex --json                    # machine-readable
agent-pace claude --watch --alerts-only    # poll every 5 minutes, speak only when off target
agent-pace plan                            # read both once, say where spare work should go
```

Run it as `claude-pace` or `codex-pace` and the source is picked from the name. The binary
takes it from any link or copy with that name; run from source, only the `claude-pace` and
`codex-pace` entries that `bun install` links do.

### Sources

- **claude:** the Claude Code subscription windows (5-hour and 7-day), the numbers Claude
  Code's `/usage` shows, the banked usage-limit resets that Claude Code's `/limit-reset`
  claims (grants with resets left), and the usage credits that `/usage-credits` buys (extra
  usage: the spend limit, what is spent, and the prepaid balance).
- **codex:** the Codex CLI windows (for example the weekly window on a ChatGPT plan), the
  banked rate-limit resets on the account and its Codex credits, read from `codex app-server`
  (`account/rateLimits/read`, read only). If the app server is not available, the windows and
  credits come from the rate-limit snapshots Codex writes into its own session logs (as fresh
  as your last Codex turn) and the banked resets are reported as unknown.
- **Through a hub:** on a machine whose Claude Code or Codex goes through a
  [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) auth hub, the accounts on the
  hub, pooled (see [Through a CLIProxyAPI hub](#through-a-cliproxyapi-hub)).

### What it reports

Per window: usage, burn rate, time to reset, the projected usage at reset, and the rate that
lands on `--target`. A short window's burn is its recent rate. A week is bursty, so it is paced
by what the lanes running now spend, measured from their own tokens ("0.1%/h (lanes, window avg
0.8%/h)"), and by its average so far ("window avg") while that is not learned or no lane is
spending. A week's whole points move too seldom for a recent rate to pace it. It takes resets
into account:
- When a window rolls over, it says how the finished window ended against the target (for
  example "ended at 96%, 4% unused").
- `--plan even` caps the short window's target by what the long window can afford: the long
  window's remaining budget spread over the short windows left before the long window resets.
  It learns how many long-window points one short-window point costs from its own history.
  `--plan fill` (the default) aims every short window at `--target` until the long window has
  only `--reserve` points left (default 10), then paces like `--plan even` so the rest lasts
  until the long window resets.

### Banked resets

Both providers can grant resets that refill a window and expire if unused. A banked reset is
used by filling the window it clears to about 100% and then redeeming it, so with one banked
the target is 100%, not `--target`, and running out early is fine: there is no `--reserve`
taper and no "slow down". A deadline is the latest time to fill the window by, not a speed
limit: lane headroom with a reset banked only asks that the window not reach 100% before the
next reading. A Codex reset clears every window, so it is spent on the longest. A
Claude grant clears the windows it lists: a session grant only the 5h window (so it only lifts
the 5h target), a weekly or full grant the 7d window.
- A reset that expires before the window resets: the target is 100% by that expiry minus
  `--redeem-margin` (default 2h). The report says the rate needed and the current rate. If that
  cannot be reached even at the peak rate seen in this window, it says to redeem shortly before
  the expiry anyway, because an unused reset is lost.
- Resets that all expire after the window resets (or whose expiry is not known): the target is
  100% at the window's reset.
- At the limit: "at limit: redeem a banked reset". agent-pace never redeems anything: redeem a
  Codex reset in Codex, and run `/limit-reset` in Claude Code. If nothing expires before the
  window resets and it resets on its own within `--redeem-margin`, redeeming would waste the
  reset: it says to keep it banked.
- With none banked, nothing changes. When the count cannot be known (the Codex app server is
  unavailable, or the Claude endpoint does not report it) the pacing is unchanged too.

### Lane headroom

"room left: add work" does not mean start as many agent lanes as you like. Every reading says
how many more lanes the headroom supports (and "no lane headroom: start nothing new" at 0, even
where the window has room):
- **Lanes active:** Claude Code session and subagent files under `$CLAUDE_CONFIG_DIR/projects`
  (default `~/.claude/projects`) whose last assistant message is under 10 minutes old; Codex
  rollout files under `$CODEX_HOME/sessions` written in the last 10 minutes. Only mtimes and one
  tail read per fresh file.
- **Per-lane burn, measured:** each lane's own tokens. Claude Code records a `usage` block on
  each assistant message, and Codex a `token_usage_record` per response. agent-pace prices each
  request at API list prices, which captures how much each kind of token (input, output, cache
  read, cache write) and each model costs relative to the others. It then learns from its own
  history how many window points a dollar of that is worth, separately for each window (see
  [Points per dollar](#points-per-dollar)). A lane's burn is its spending over the last 30
  minutes, or since it started if that is later, times points per dollar. The lanes counted
  are those that spent something in the last 10 minutes, which can be fewer than
  `active_lanes`: a session with a recent message that cost nothing is open, not working. Each
  request is counted once, at its final cost, in the session that first wrote it, so a forked
  or resumed session's copied history is not counted again.
- **Per-lane burn, shared out:** while points per dollar are not learned yet, the recent rate
  of the window (not the window average) is divided by the lanes active over the stretch it
  was measured on.
- **Evidence:** usage comes in whole points, so a reading can be a point off and two readings
  ten minutes apart say little (0% -> 2% is anything from 6 to 18%/h). A rate counts once it is
  known to within a third. When use steps up between two readings it crossed a whole point in
  that gap, so two steps timed at their gaps' midpoints measure the points between them
  (readings a minute apart time one point in ten minutes to within a tenth); the latest step
  must not be overdue at that rate. Otherwise the stretch ends at the latest reading and
  reaches back until use moved at least 3 points; the rate is that move over the span. If it
  reaches back a fifth of the window first (1 hour of a 5h window, 33.6 hours of a week), the
  move plus one point over the span bounds the burn from above ("at most"; it can show room
  left, never on target or over, and gives no projection). Anything shorter is no estimate,
  nor is a stretch across a drop in use or one whose latest reading is over 10 minutes old.
  The rate a short window's status and projection use is held to the same evidence (a
  day-long window is paced by its running lanes' tokens, or its average).
- **Time-weighted lanes:** the lanes are weighted from the counts agent-pace remembers at each
  reading (`lanes-<source>.csv`) and the count now. A count covers the 10 minutes before it,
  back to the count before it, so a count taken before the lanes started does not dilute them.
  Time no count covers is left out; with less than half the stretch covered there is no
  estimate.
- **Lanes supported** = (aim - used - running burn * running hours) / (per-lane burn * lane
  hours), rounded down, not below 0. A new lane is started for `--lane-hours` (default 1) and
  then read again, so it counts only for those hours (never past the window's reset); the lanes
  already running are taken to go on until the window resets. With a reset banked running out
  early is fine (redeem it then), so the running lanes too count only for the lane hours. Shared
  out, the running burn is the per-lane burn times the lanes running now; measured, the lanes
  running burn what they each burn and a new lane is taken to burn their average. The aim is
  the target (100% with a reset banked; 100% for a window paced through the other's cap). The
  window with the least room binds (the longer one on a tie). Read again before starting more:
  the lanes started last time are running lanes now.
- **Measuring:** without an estimate, or with no active lanes, it says "measuring" and suggests
  at most 1-2 new lanes. One window that cannot be measured yet makes the whole source
  unmeasured, unless another window has no room, or it is far below its aim: even at twice its
  average burn so far (after its first hour) it would end at or below the aim, as a week at 6%
  with 111 hours left would. A window with nothing banked whose projection runs out before its
  reset has no room either.

`--json` adds `active_lanes`, `per_lane_rate`, `lane_headroom`, `lane_hours` (the hours a new
lane was given) and `lane_binding` (the window whose headroom the source reports) to each
window, and a `lanes` summary with the same `hours` and the `pool` the lanes draw on: `plan`,
or `usage-credits` once a window is at its limit (then its headroom and per-lane rate are the
credits', in their unit; see [Usage credits](#usage-credits)). `rate_basis` is `lanes` when a
week is paced by its running lanes' tokens, and `window_average_rate` gives the window's average burn beside
it. `lane_basis` says
how the per-lane burn was found (`tokens`, `shared`, or null without one), `lane_rates` lists
each measured lane's burn, highest first, and `token_cost` gives the learned
`points_per_dollar` with the `runs`, `points` and `dollars` it was learned from.

### Usage credits

Usage credits keep work going once a window is at its limit: Claude's extra usage (bought with
`/usage-credits`, up to the spend limit) and Codex credits. They are money, so agent-pace paces
the lanes against what is left of them, and says that is the pool they draw on:

```console
$ agent-pace claude
12:25 claude: 5h 6% ? 1.17h left (80.6%/h lands on 100.0%) -> measuring | 7d 100% 0.6%/h (window avg) 6.0h left, runs out in ~0.0h, even pace 0.0%/day -> on usage credits (429.39 GBP left): room for ~2 more lanes at 30.00 GBP/h each for 1.0h
```

- **Left:** for Claude, the room under the spend limit or the prepaid balance, whichever is
  less (Claude Code's own sum), in the account's currency. With auto-reload on, the balance
  does not cap it; with no spend limit as well, nothing does ("no spend limit"). Extra usage
  turned off, or turned off because the credits ran out or the limit was reached, is no
  credits. For Codex, the credit balance; unlimited credits have nothing that caps them.
- **When they count:** only while a window is at 100% with no lane headroom, until the windows
  at their limit have reset. Below the limit, or with no credits left, the lanes read as
  before ("no lane headroom: start nothing new").
- **Draw:** agent-pace records what the credits have spent at each reading
  (`<source>-credits.csv`) and measures their draw as it measures a window's recent burn: over
  the latest stretch of at least 9 minutes in which at least 3 units were spent, shared out
  over the lanes active meanwhile. It is in the credits' own unit, so no exchange rate or price
  list comes into it.
- **Lanes supported** = (left - running draw * hours to the reset) / (per-lane draw * lane
  hours), rounded down, not below 0: the running lanes draw until the window resets, a new one
  for `--lane-hours`. Until the draw is measured, or with nothing capping the credits, it says
  "measuring" and suggests at most 1-2 new lanes.
- **plan** still routes spare work to a provider with room in its plan first, since credits
  cost money. When neither plan has room, it routes work to the provider with credits ("route
  work to Claude on usage credits (429.39 GBP left), or wait for a reset").

`--json` adds `usage_credits` to each source (null without credits to draw on): `unit`, `left`
(null when nothing caps it), `drawing`, `hours_left`, `rate_per_hour`, `per_lane_rate`,
`lane_headroom` and `lane_hours`.

### Points per dollar

The readings of one window, between resets and cut at any drop in use, make runs. A run from
its first reading to its last moved Δu whole points while the local lanes spent D dollars, so
a window's points per dollar are Σ Δu / Σ D over the runs the ledger covers (eight days, so
the week that just ended keeps teaching the 7d window for a day into the next). Each run's Δu is a
difference of whole points and so can be a point off; over n runs the sum can be n points off.
The fit counts once Σ Δu is at least 3 points per run, which keeps that error within a third,
the bar a recent rate has to clear.

A run whose local lanes spent less than a twentieth of what a point usually costs them (the
median over the runs) says little about what a local lane costs and is left out: another
machine, or claude.ai, moved the window then. Use from elsewhere during a run
is counted against the local lanes, as the shared-out estimate counts it, so a busy other
machine makes local lanes look more expensive than they are, never cheaper. List prices are
ratios, not the subscription's own accounting: if a window weighs a kind of token or a model
differently from its price, lanes whose mix differs from the average are measured that much
off.

Each request is priced by its own model, at the list prices in `src/token-prices.ts`. A Claude
message names its model and fast mode doubles it. A Claude Haiku 5.5 prompt over 100K tokens
(input, cache reads and cache writes together) pays five times every rate for the whole
request; the other current Claude models bill their full context at one rate. A Codex usage record names neither, so each
rollout's latest `turn_context` and `thread_settings_applied` lines supply its model and
service tier: Fast (`priority`) costs twice Standard, Ultrafast six times and Flex half. A
Codex prompt over 272K input tokens is billed at long-context rates (input and cache twice,
output one and a half times), and its cache writes at the default 30-minute rate. A rollout
written before Codex recorded its tier is priced at Standard. A model the tables do not list
is priced as the current model of its family (Claude) or tier name (Codex `sol`, `astra`,
`terra`, `luna`), and otherwise as Opus 5.5 or GPT-6.1 Sol.

### plan

`agent-pace plan` reads both sources once and weighs both providers' banked resets and
expiries, then prints one recommendation, for example to route spare work to Codex when a
banked reset is about to expire or when Claude's window is nearly used, followed by how many
more lanes each provider supports. It changes nothing.

### Options

| Option                               | Default                     | Meaning                                                                                                                                                                        |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--target`                           | 100                         | the usage to aim for at each reset, in percent                                                                                                                                 |
| `--band`                             | 3                           | alert below `--target` minus this many points                                                                                                                                  |
| `--interval`                         | 300                         | seconds between readings with `--watch`                                                                                                                                        |
| `--plan fill\|even`                  | fill                        | how the short window is paced against the long one                                                                                                                             |
| `--reserve`                          | 10                          | with `--plan fill`, pace like `--plan even` once the long window has this many points left                                                                                     |
| `--redeem-margin HOURS`              | 2                           | fill a window to 100% this many hours before a banked reset expires; at the limit, keep a reset (nothing expires first) if the window resets on its own within this many hours |
| `--lane-hours HOURS`                 | 1                           | the hours each new lane is given before the next reading when counting lane headroom                                                                                           |
| `--state DIR`                        | `~/.local/state/agent-pace` | where the history is kept (`$XDG_STATE_HOME/agent-pace` when that is set)                                                                                                      |
| `--notify CMD`                       |                             | run CMD with the alert text as its last argument on each alert or reset, e.g. `--notify notify-send` or `--notify 'curl -d'` plus an ntfy URL                                  |
| `--watch`, `--alerts-only`, `--json` |                             | poll; print only alerts; print JSON                                                                                                                                            |

### State

agent-pace keeps its history in `~/.local/state/agent-pace/`: one CSV per source and window
(`claude-5h.csv`, `codex-7d.csv`: observed at, used, resets at), the lane counts
(`lanes-<source>.csv`), what the usage credits have spent (`<source>-credits.csv`), the Claude
banked resets and credits from the last reading (`claude-banked.json`), and what each lane spent per minute over the last eight days with how far
each session file has been read (`tokens-<source>.json`). On a hub client the pool's readings
go into their own files (`claude-pool-5h.csv`, `codex-pool-7d.csv`), with the pool's accounts
and shares at the last reading (`claude-pool-members`) and the address that last answered as a
hub (`claude-pool-hub`). The first reading reads the last
eight days of session files, a few seconds for a busy week; later readings read only what was
appended. Claude readings are shared per machine through a lock and a one-minute
cache, so run one watcher rather than one per agent.

## Through a CLIProxyAPI hub

A CLIProxyAPI hub holds several Claude and Codex logins and routes each request to one of
them. A machine that sends its Claude Code or Codex to the hub has no login of its own to read
(any login left on it is not the one being used), so agent-pace reads the hub's accounts
instead and paces their pool:

```console
$ agent-pace claude
12:25 claude pool (2 of 3 accounts): 5h 55% 12.0%/h 1.75h left, ends ~76% (25.7%/h lands on 100.0%) -> no lane headroom: start nothing new | 7d 65% 0.8%/h (window avg) 84.0h left, runs out in ~43.8h (0.4%/h lands on 100.0%) -> slow down
  work (weight 3): 5h 40% resets Wed 22 Oct 14:25 (in 2.0h) | 7d 60% resets Sat 25 Oct 12:25 (in 72.0h); 1 banked, next expires Fri 24 Oct 12:25
  claude 2: 5h 100% resets Wed 22 Oct 13:25 (in 1.0h) | 7d 80% resets Mon 27 Oct 11:25 (in 120.0h); cooling down on the hub
  claude 3: disabled on the hub, not in the pool
  claude 4: unreadable (HTTP 401), left out of the pool
```

The first line is the pool, worded as a single account's line is, and its verdict (`room
left: add work`, `keep going`, `slow down`) answers for the pool. Below it is one line per
account on the hub: its windows, their resets and its banked resets, or why it is left out.

### Which machines read the hub

- **claude:** `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`) sets both
  `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN`, as a hub client is usually set up.
- **codex:** `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) sets
  `model_provider = "cliproxy"`, and its `[model_providers.cliproxy]` table has `base_url`
  (the hub's address and `/v1`) and the key, as `experimental_bearer_token` or in the
  environment variable `env_key` names.

agent-pace then asks that address, at `<hub>/agent-pace/v1/usage/<claude|codex>`, with that
same access key: a client needs no other secret. Only an https address (or plain http to this
machine itself) is asked. It is a hub when the answer carries the `X-Agent-Pace-Hub` header
that `agent-pace hub serve` puts on every answer; then the pool is read and the machine's own
login never is, and the address is remembered as a hub (`<source>-pool-hub`). Until an address
has answered so, any other answer or none (a gateway that is no hub, a hub without the service,
a local router that is not running) leaves agent-pace reading this machine as before, as does a
plain-http address elsewhere or a config without a key. Once it has, an answer without the
header or none is a failed reading, as an unreachable usage endpoint is: a hub whose service is
down is still the hub, and this machine's own login is not the one in use. On the hub machine
itself, Claude Code and Codex point at CLIProxyAPI's own port, which is no agent-pace service, so
agent-pace there reads that machine as before.

### The pool

Each account counts with a **capacity**: the `weight` its credential has on the hub
(CLIProxyAPI's per-credential integer, set in the account's auth file or the management panel),
1 when it has none. Plans are not turned into sizes: the providers do not publish how many
times one plan's window holds another's, so give a bigger account a bigger weight (for example
4 for a plan four times the size). `--json` shows each account's plan where the provider names
it (Codex) and its weight.

For each window (5h and 7d for Claude, the windows Codex reports), over the accounts in the
pool, with `c` an account's capacity, `u` its use of its own window in percent and `t` the
time that window resets:
- **use** = Σ c·u / Σ c. An account without that window running (no Claude session in the last
  five hours) counts as 0%.
- **reset** = Σ c·t / Σ c over the accounts with that window running; now plus the window's
  length if none has it running. The hours left are to that time.

If every account in the pool has the window running and burns the same share of its own
capacity each hour, account `i` ends its window at `u_i + r·h_i`, and the capacity-weighted
mean of those ends is exactly `use + r·hours left`. With an account whose window is not
running, the mean reset leaves it out, so this is an approximation until its window starts.
So the pool's projection is the mean of where the accounts' windows end, the target
(`lands on 100%`) asks that they end full on average, and `runs out` / `slow down` says that on
average they reach their limit before they reset. It is a mean: one account can reach its
limit while the pool has room (the hub then routes around it, and its line says `cooling down
on the hub`).
- **In the pool:** the accounts the hub has enabled whose usage was read, with a capacity above
  0. A disabled account is not counted at all. An unreadable one is left out of both means, and
  the line says so ("2 of 3 accounts"); the room it has is then missing from the verdict. An
  account with weight 0 is left out. An account the hub is cooling down counts with the use it
  reports. An account whose read fails counts with its last good reading for up to half an
  hour (without the windows that have reset since), and its line says when that was read
  ("as read Wed 22 Oct 12:20 (now HTTP 429)"). With no account readable, the reading fails as
  an unreachable endpoint does.
- **Rate:** the pool keeps its own history (`claude-pool-5h.csv` and so on) and its rate is
  measured from it as a single window's is, held to the same evidence. When an account resets,
  the pool's use drops and its reset time moves: that starts a new stretch, so the rate is
  measured again from there. It is no end of the pool's window, so a pool never says "window
  reset", and `previous_window_ended_at` is null. When an account joins or leaves the pool, or
  its weight changes, or an account starts or stops standing in with an older reading, the
  pool's use moves by more than anything burned: the pool's history starts over then (the accounts and shares of the last reading are kept in
  `<source>-pool-members`), and the rate is measured afresh.
- **Banked resets** are listed on each account's line and in `--json`, and do not change the
  pool's pacing: a reset refills one account, a share of the pool, and is redeemed for that
  account. The pool's own `banked_resets` is unknown (`known: false`, `via: "hub"`).
- **Usage credits** are not read through the hub.
- **Lanes** are counted on this machine, as without a hub. Other machines' lanes draw on the
  same pool: their use shows in the pool's rate but not in the lane count, so the per-lane burn
  (shared out, or the points per dollar learned from this machine's spending) comes out higher
  than a lane costs, and the headroom lower. Each machine paces its own lanes against what is
  left of the whole pool.

`--json` adds `hub` to the source: the hub's `url`, `observed_at`, `accounts_in_pool`,
`accounts_enabled`, `pool_capacity` (Σ c), and `accounts`, each with `label`, `plan`, `weight`
(null when unset), `capacity`, `in_pool`, `state` (`ok`, `disabled` or `unreadable`), `detail`
(why it is unreadable, or why its reading is an older one), `read_at` (when its windows were
read), `cooling_down`, `windows` (`window`, `used`, `resets_at`,
`hours_left`) and `banked_resets` (`known`, `count`, `credits`). The pool's `windows` are the
usual window objects.

### On the hub: `agent-pace hub serve`

```sh
agent-pace hub serve        # on the hub, beside CLIProxyAPI, as a service
```

It reads the accounts with CLIProxyAPI's management API: `GET /v0/management/auth-files` lists
them, and `POST /v0/management/api-call` makes one request with an account's login (CLIProxyAPI
puts the account's token where a header says `$TOKEN$`). Because that can send any account's
token anywhere, the management key never leaves the hub: the service runs there, takes
CLIProxyAPI only on this machine (`--cliproxy`, default `http://127.0.0.1:8317`) and listens on
127.0.0.1 only (`--port`, default 8318), and the hub publishes it on its tailnet address
under `/agent-pace`. Its options:

| Option           | Default                     | Meaning                                                        |
| ---------------- | --------------------------- | -------------------------------------------------------------- |
| `--port`         | 8318                        | the port on 127.0.0.1 to listen on                             |
| `--keys DIR`     | `~/.config/cliproxyapi`     | the directory with the `access-key` and `management-key` files |
| `--cliproxy URL` | `http://127.0.0.1:8317`     | CLIProxyAPI, on this machine only                              |
| `--state DIR`    | `~/.local/state/agent-pace` | where the Claude Code version it claims is remembered          |
- **Requests:** `GET /v1/usage/claude` and `GET /v1/usage/codex` (the same under
  `/agent-pace/`), with `Authorization: Bearer <access key>`, the key in `access-key`, compared
  in constant time. Without it: 401. Anything else: 404, or 405 for another method.
- **Upstream:** only GETs. For a Claude account, the usage endpoint Claude Code's `/usage`
  reads (as above, with `?cedar_ember=1` for the banked resets). For a Codex account,
  `https://chatgpt.com/backend-api/wham/usage`, the endpoint Codex reads its rate limits from,
  and, when that says resets are banked, `.../wham/rate-limit-reset-credits` for their expiries.
  It never redeems or claims a reset.
- **Cache:** each provider's accounts are read at most once a minute, however many clients ask;
  a failed read is not kept. An account whose usage endpoint answers 429 is not asked again
  until its `Retry-After` has passed (10 minutes without one), and an account whose read fails
  is answered with its last good reading for up to half an hour, its `detail` saying why and
  `read_at` when it was read.
- **Answer:** `{"version": 1, "provider", "observed_at", "accounts": [...]}`, each account with
  `label`, `plan`, `weight`, `cooling_down`, `state`, `detail`, `read_at`, `windows` (`name`,
  `used`, `resets_at`, `length_s`; times in unix seconds) and `banked` (`count`, `credits` with
  `expires_at`, `title`, `clears`; null when unknown), with the header `X-Agent-Pace-Hub: 1`.
  The `label` is the note the credential has on the hub (unless it looks like an email
  address), else the provider and its place in the hub's list ("claude 2"), which moves when an
  account is added: set a note for a lasting name. No token, email address or upstream body is
  ever in it; `detail` is the upstream status ("HTTP 401") or what failed. A management API
  that fails answers 502 with what failed; missing key files 503.

## Credentials and the endpoints it reads

Claude credentials come from `$CLAUDE_CODE_OAUTH_TOKEN`, then the macOS Keychain item
"Claude Code-credentials", then `$CLAUDE_CONFIG_DIR/.credentials.json` (default
`~/.claude/.credentials.json`). They are never printed or stored. If the token has expired,
run `claude` once.

The Claude endpoint (`https://api.anthropic.com/api/oauth/usage`) is the one Claude Code's
`/usage` uses; it is not a documented public API. One call, with `?cedar_ember=1`, also
returns the banked resets (`cedar_ember`) and the extra usage (`extra_usage`, which
`skip_spend=1` would leave out). With extra usage on, a second call reads the prepaid balance
(`/api/oauth/organizations/<org>/prepaid/credits`, as `/usage-credits` does), for the
organization in `$CLAUDE_CODE_ORGANIZATION_UUID` or Claude Code's config
(`oauthAccount.organizationUuid` in `$CLAUDE_CONFIG_DIR/.claude.json`, default
`~/.claude.json`). If it cannot be read, the credits are unknown and the pacing is as before. The server only evaluates those for the Claude
Code surface, so the request identifies itself as the installed Claude Code (User-Agent
`claude-cli/<version> (external, cli)`, `x-app: cli`; the version comes from
`claude --version`, remembered for a day, else a built-in one). That is fragile: if the server
stops taking agent-pace for Claude Code, the banked resets show as unknown and the pacing is as
before. agent-pace never claims a reset.

The Codex app server is `codex app-server` (JSON-RPC over stdio, bounded by a timeout and
always terminated); the fallback snapshots come from `$CODEX_HOME/sessions` (default
`~/.codex/sessions`), whose format is Codex's internal one. Either may change without notice.

## The Python version

agent-pace 1.4 was a Python script. This TypeScript version prints the same text and `--json`
digit for digit, takes the same flags, and reads and writes the same state files, so a history
the Python version kept carries over. Five things are new: the measured per-lane burn, which
changes the lane numbers once points per dollar are learned; lane headroom over
`--lane-hours` with a week paced by its running lanes (2.0), which changes the lane numbers, a
week's rate and status, and the lane wording; usage credits (3.0), which give a window at its
limit lane headroom on the credits; reading a CLIProxyAPI hub's pool on a machine that goes
through one, and `agent-pace hub serve` (5.1); and the `--json` fields and state files that
describe them.
Otherwise they differ only here:
- Failures the operating system reports use urllib's and OSError's frames (`<urlopen error
  ...>`, `[Errno 2] No such file or directory: ...`); a refused connection and an unknown host
  read as Python's did, other failures carry Bun's wording.
- Usage errors follow Python 3.15's argparse, including its suggestion of a close choice
  ("maybe you meant 'even'?"), but never in colour.
- A corrupt `claude-banked.json` reads as unknown banked resets, and unreadable credentials
  give the "could not read" message, where Python stopped with a traceback.
- Responses with `NaN` or `Infinity` literals, and timestamps in ISO 8601 forms the providers
  do not send (week dates, text after the seconds), are rejected where Python read some of them.

## Development

```sh
bun install
bun run check   # Biome, the typecheck and the parity suite
bun run build   # dist/agent-pace for this machine
```

## Licence

MIT. No warranty.
