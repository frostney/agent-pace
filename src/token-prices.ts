// What a request's tokens would cost at API list prices, in US dollars. Subscription windows do
// not bill in dollars, but list prices are the best public statement of how much each kind of
// token and each model costs relative to the others; agent-pace learns how many window points
// a dollar of that is worth (src/token-burn.ts), so only the ratios matter.

/** Dollars per million tokens. */
interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

/** Claude list prices as of October 2026: cache writes at 1.25x (5 minutes) and 2x (1 hour) input. */
function claude(input: number, output: number, cacheRead: number): Price {
  return { input, output, cacheRead, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2 };
}

const CLAUDE_PRICES: ReadonlyMap<string, Price> = new Map([
  ["claude-fable-5-1", claude(10, 50, 0.25)],
  ["claude-mythos-5-1", claude(10, 50, 0.25)],
  ["claude-fable-5", claude(10, 50, 1)],
  ["claude-opus-5-5", claude(4, 20, 0.2)],
  ["claude-opus-5", claude(5, 25, 0.5)],
  ["claude-opus-4-8", claude(5, 25, 0.5)],
  ["claude-opus-4-7", claude(5, 25, 0.5)],
  ["claude-opus-4-6", claude(5, 25, 0.5)],
  ["claude-sonnet-5-5", claude(2, 10, 0.2)],
  ["claude-sonnet-5", claude(2, 10, 0.2)],
  ["claude-sonnet-4-6", claude(3, 15, 0.3)],
  ["claude-haiku-5-5", claude(0.1, 0.5, 0.01)],
  ["claude-haiku-4-5", claude(1, 5, 0.1)],
]);

/** A model this table does not list is priced as the current model of its family. */
const CLAUDE_FAMILIES: readonly (readonly [string, string])[] = [
  ["fable", "claude-fable-5-1"],
  ["mythos", "claude-mythos-5-1"],
  ["opus", "claude-opus-5-5"],
  ["sonnet", "claude-sonnet-5-5"],
  ["haiku", "claude-haiku-5-5"],
];

/**
 * Codex models are priced at the GPT-5 family's ratios (cached input a tenth of input, output
 * eight times it). One Codex model at a time sets the level, and the learned scale absorbs it.
 */
const CODEX_PRICE: Price = {
  input: 1.25,
  output: 10,
  cacheRead: 0.125,
  cacheWrite5m: 1.25,
  cacheWrite1h: 1.25,
};

export function claudePrice(model: string): Price {
  const listed = CLAUDE_PRICES.get(model);
  if (listed) {
    return listed;
  }
  const family = CLAUDE_FAMILIES.find(([name]) => model.includes(name));
  return CLAUDE_PRICES.get(family?.[1] ?? "claude-opus-5-5") ?? claude(4, 20, 0.2);
}

/** Tokens of one request, by kind. Input excludes cache reads and writes. */
export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
}

export function cost(tokens: Tokens, price: Price): number {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWrite5m * price.cacheWrite5m +
      tokens.cacheWrite1h * price.cacheWrite1h) /
    1e6
  );
}

export function codexPrice(): Price {
  return CODEX_PRICE;
}
