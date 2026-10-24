// What a request's tokens would cost at API list prices, in US dollars. Subscription windows do
// not bill in dollars, but list prices are the best public statement of how much each kind of
// token and each model costs relative to the others; agent-pace learns how many window points
// a dollar of that is worth (src/token-burn.ts), so only the ratios matter.

/** Dollars per million tokens. */
interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWriteShort: number;
  readonly cacheWriteLong: number;
}

/** Claude list prices as of October 2026: cache writes at 1.25x (5 minutes) and 2x (1 hour) input. */
function claude(input: number, output: number, cacheRead: number): Price {
  return { input, output, cacheRead, cacheWriteShort: input * 1.25, cacheWriteLong: input * 2 };
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
 * A model whose request is billed at a multiple of its price when the prompt (input, cache
 * reads and cache writes) is longer than a threshold: [prompt tokens, factor on every rate].
 */
const CLAUDE_LONG_CONTEXT: ReadonlyMap<string, readonly [number, number]> = new Map([
  ["claude-haiku-5-5", [100_000, 5]],
]);

/** The price of one Claude request: its model's, at its long-context rate if the prompt has one. */
export function claudePrice(model: string, prompt: number): Price {
  const family = CLAUDE_FAMILIES.find(([name]) => model.includes(name));
  const priced = CLAUDE_PRICES.has(model) ? model : (family?.[1] ?? "claude-opus-5-5");
  const price = CLAUDE_PRICES.get(priced) ?? claude(4, 20, 0.2);
  const [threshold, factor] = CLAUDE_LONG_CONTEXT.get(priced) ?? [Number.POSITIVE_INFINITY, 1];
  return prompt > threshold ? scaled(price, factor, factor) : price;
}

function scaled(price: Price, input: number, output: number): Price {
  return {
    input: price.input * input,
    output: price.output * output,
    cacheRead: price.cacheRead * input,
    cacheWriteShort: price.cacheWriteShort * input,
    cacheWriteLong: price.cacheWriteLong * input,
  };
}

/**
 * OpenAI list prices as of October 2026, Standard tier, for prompts of up to 272K input tokens.
 * From GPT-5.6 on, a cache write costs 1.25x input for the default 30 minutes and 2.5x for 12
 * hours; earlier models bill no cache writes, so their written tokens cost what input does.
 */
function openai(input: number, output: number, cacheRead: number, writes = true): Price {
  return writes
    ? { input, output, cacheRead, cacheWriteShort: input * 1.25, cacheWriteLong: input * 2.5 }
    : { input, output, cacheRead, cacheWriteShort: input, cacheWriteLong: input };
}

const CODEX_PRICES: ReadonlyMap<string, Price> = new Map([
  ["gpt-6-astra", openai(10, 50, 1)],
  ["gpt-6.1-sol", openai(2, 10, 0.1)],
  ["gpt-6-sol", openai(2, 10, 0.2)],
  ["gpt-6-luna", openai(0.1, 0.5, 0.01)],
  ["gpt-5.6-sol", openai(4, 20, 0.4)], // a promotional price, at least through 2026-11-21
  ["gpt-5.6-terra", openai(2, 12, 0.2)],
  ["gpt-5.6-luna", openai(0.2, 1.2, 0.02)],
  ["gpt-5.5", openai(5, 30, 0.5, false)],
  ["gpt-5.5-pro", openai(30, 180, 30, false)], // no cached-input rate
  ["gpt-5.4", openai(2.5, 15, 0.25, false)],
  ["gpt-5.4-pro", openai(30, 180, 30, false)],
]);

/** A model this table does not list is priced as the current model of its tier. */
const CODEX_FAMILIES: readonly (readonly [string, string])[] = [
  ["astra", "gpt-6-astra"],
  ["sol", "gpt-6.1-sol"],
  ["terra", "gpt-5.6-terra"],
  ["luna", "gpt-6-luna"],
];

/** A prompt of more input tokens than this is billed at long-context rates for the whole request. */
const OPENAI_SHORT_CONTEXT = 272_000;

/**
 * The price of one Codex request: its model's, a dated snapshot priced as the model, at
 * long-context rates (2x input and cache, 1.5x output) when its prompt is longer than 272K.
 */
export function codexPrice(model: string, prompt: number): Price {
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const family = CODEX_FAMILIES.find(([name]) => base.split("-").includes(name));
  const price =
    CODEX_PRICES.get(base) ?? CODEX_PRICES.get(family?.[1] ?? "gpt-6.1-sol") ?? openai(2, 10, 0.1);
  return prompt > OPENAI_SHORT_CONTEXT ? scaled(price, 2, 1.5) : price;
}

/** What a Codex service tier costs against Standard: Fast is twice it, Ultrafast six times. */
export function codexTierFactor(tier: string): number {
  switch (tier) {
    case "priority":
      return 2;
    case "ultrafast":
      return 6;
    case "flex":
      return 0.5;
    default:
      return 1;
  }
}

/**
 * Tokens of one request, by kind. Input excludes cache reads and writes. A short cache write
 * lasts 5 minutes on Claude and 30 minutes on OpenAI; a long one an hour and 12 hours.
 */
export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWriteShort: number;
  readonly cacheWriteLong: number;
}

export function cost(tokens: Tokens, price: Price): number {
  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * price.cacheRead +
      tokens.cacheWriteShort * price.cacheWriteShort +
      tokens.cacheWriteLong * price.cacheWriteLong) /
    1e6
  );
}
