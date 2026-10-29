# agent-pace

agent-pace paces AI coding-agent work against your plan's usage windows. It reads Claude Code's
5-hour and 7-day windows and Codex's windows, projects each one at its reset, counts the banked
resets on your account, and says how many more agent lanes the headroom supports. It only
advises: it never redeems a reset.

```console
$ agent-pace plan
route spare work to Codex: banked reset expires in 36h and cannot be filled by then (needs 2.4%/h, peak 0.7%/h); fill what you can, then redeem it (lanes: Codex room for ~264 more lanes at 0.3%/h each for 1.0h; Claude measuring: start at most 1-2 new lanes)
  12:25 claude: 5h 6% ? 1.17h left (78.0%/h lands on 97.0%) -> measuring | 7d 40% 0.6%/h (window avg) 96.0h left, ends ~93% (0.6%/h lands on 97.0%) -> keep going (measuring: start at most 1-2 new lanes)
  12:25 codex: 7d 20% 0.6%/h (lanes, window avg 0.7%/h) 139.81h left, runs out in ~5.6d (2.4%/h lands on 100%) -> room left: add work (room for ~264 more lanes at 0.3%/h each for 1.0h)
    banked reset expires Fri 24 Oct 00:10 (in 35.8h): cannot reach 100% by then (needs 2.4%/h, peak seen 0.7%/h); redeem it anyway by Thu 23 Oct 22:10, an unused reset is lost [3 banked]
```

## Install

Each [release](https://github.com/frostney/agent-pace/releases) has a standalone binary for
macOS and Linux (arm64 and x64), with `claude-pace` and `codex-pace` links beside it:

```sh
version=2.0.0 target=darwin-arm64   # or darwin-x64, linux-x64, linux-arm64
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
  Code's `/usage` shows, and the banked usage-limit resets that Claude Code's `/limit-reset`
  claims (grants with resets left).
- **codex:** the Codex CLI windows (for example the weekly window on a ChatGPT plan) and the
  banked rate-limit resets on the account, read from `codex app-server`
  (`account/rateLimits/read`, read only). If the app server is not available, the windows come
  from the rate-limit snapshots Codex writes into its own session logs (as fresh as your last
  Codex turn) and the banked resets are reported as unknown.

### What it reports

Per window: usage, burn rate, time to reset, the projected usage at reset, and the rate that
lands on `--target`. A short window's burn is its recent rate. A week is bursty, so it is paced
by what the lanes running now burn ("0.1%/h (lanes, window avg 0.8%/h)"), and by its average so
far ("window avg") while that is not known or no lane is running. It takes resets into account:
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
  day-long window is paced by its running lanes, or its average).
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
window, and a `lanes` summary with the same `hours`. `rate_basis` is `lanes` when a week is
paced by its running lanes, and `window_average_rate` gives the window's average burn beside
it. `lane_basis` says
how the per-lane burn was found (`tokens`, `shared`, or null without one), `lane_rates` lists
each measured lane's burn, highest first, and `token_cost` gives the learned
`points_per_dollar` with the `runs`, `points` and `dollars` it was learned from.

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
| `--target`                           | 97                          | the usage to aim for at each reset, in percent                                                                                                                                 |
| `--band`                             | 7                           | alert below `--target` minus this many points                                                                                                                                  |
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
(`lanes-<source>.csv`), the Claude banked resets from the last reading
(`claude-banked.json`), and what each lane spent per minute over the last eight days with how far
each session file has been read (`tokens-<source>.json`). The first reading reads the last
eight days of session files, a few seconds for a busy week; later readings read only what was
appended. Claude readings are shared per machine through a lock and a one-minute
cache, so run one watcher rather than one per agent.

## Credentials and the endpoints it reads

Claude credentials come from `$CLAUDE_CODE_OAUTH_TOKEN`, then the macOS Keychain item
"Claude Code-credentials", then `$CLAUDE_CONFIG_DIR/.credentials.json` (default
`~/.claude/.credentials.json`). They are never printed or stored. If the token has expired,
run `claude` once.

The Claude endpoint (`https://api.anthropic.com/api/oauth/usage`) is the one Claude Code's
`/usage` uses; it is not a documented public API. One call, with `?cedar_ember=1&skip_spend=1`,
also returns the banked resets (`cedar_ember`). The server only evaluates those for the Claude
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
the Python version kept carries over. Three things are new: the measured per-lane burn, which
changes the lane numbers once points per dollar are learned; lane headroom over
`--lane-hours` with a week paced by its running lanes (2.0), which changes the lane numbers, a
week's rate and status, and the lane wording; and the `--json` fields that describe them.
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
