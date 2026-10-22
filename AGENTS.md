# Agent Instructions

## Hard Constraints

- Always validate. If source code is available, validate with source code.
- Bun is the only package manager and runtime. Keep `bun.lock`; do not add npm, pnpm or yarn
  lockfiles.
- TypeScript only for project code. Biome lints and formats; do not add ESLint or Prettier.
- No runtime dependencies. agent-pace reads credentials, so every dependency is a supply-chain
  risk for a tool that only needs Bun's own APIs.
- Output is a contract. The text lines, the `--json` fields and their types, the help and
  usage errors, and the state files (`~/.local/state/agent-pace/*.csv`, `claude-banked.json`)
  match what the Python version 1.4 printed and wrote, digit for digit, apart from the measured
  per-lane burn (its lane numbers and its `lane_basis`, `lane_rates` and `token_cost` fields)
  and `tokens-<source>.json`, which the Python version did not have. Number formatting goes
  through `src/python-format.ts` and JSON through `src/python-json.ts`; never use
  `toFixed`, `String(number)` or `JSON.stringify` for output. A change to any of these is a
  breaking change and needs its own release note.
- Never run agent-pace against the real backends or the real state while developing: no
  `agent-pace claude` without `--state` pointing at a scratch directory and a dummy
  `CLAUDE_CODE_OAUTH_TOKEN`, and no real `codex` on `PATH`. A run without `--state` appends to
  the user's history and calls the live usage endpoint with their login.
- agent-pace only reads. It never redeems or claims a reset, and the Codex exchange stays
  `initialize`, `initialized`, `account/rateLimits/read`.

## Runtime / Commands

```sh
bun install
bun run check   # biome ci, tsc --noEmit, bun test
bun run build   # dist/agent-pace, a standalone binary for this machine
bun bin/agent-pace.ts --help
```

## Code Organization

- `bin/` holds one entry per command name. A script sees its own file, not the link it was run
  through, so each name has its own file; a compiled binary reads the name from `argv0`.
- `src/cli.ts` runs a command: arguments, the watch loop, alerts and exit statuses.
- `src/arguments.ts` and `src/help-format.ts` reproduce argparse's parsing, help and errors.
- `src/claude.ts` and `src/codex.ts` read the two sources; `src/readings.ts` shares a Claude
  reading per machine (lock, one-minute cache, sidecar) and records history; `src/lanes.ts`
  counts active lanes; `src/history.ts` owns the CSV files.
- `src/token-ledger.ts` reads what each lane spent from the session files into
  `tokens-<source>.json`; `src/token-prices.ts` prices tokens; `src/token-burn.ts` learns
  points per dollar and gives each lane's burn.
- `src/assess.ts` turns windows and history into targets, banked-reset advice and lane
  headroom; `src/report.ts` words it as text and JSON; `src/plan.ts` is `agent-pace plan`.
- `src/host.ts` is everything taken from the machine (clock, env, fetch, output). Tests pass
  their own host instead of patching globals.

## Testing

- `tests/agent-pace.test.ts` is the parity suite: the Python version's tests, one for one,
  against the same recorded responses, with a fake `codex` and `claude` on `PATH`, a fixed
  clock and a fake usage endpoint. Keep it one for one; add new tests beside it.
- Tests never touch the network, the real `~/.claude`, `~/.codex` or state directory.
- `tests/command.test.ts` covers what the Python suite did not (exit statuses, the usage
  endpoint's error answers, help, `--watch`, `--notify`, a pacing constant); its expectations
  are the Python version's output for the same inputs.
- The Python version is retired, so a change to `src/assess.ts` is pinned by a test that
  fails without it, as `FAR_BELOW` is in `tests/command.test.ts`.
