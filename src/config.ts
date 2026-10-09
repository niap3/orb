// All sizes are UTF-8 bytes, never tokens.

export interface Config {
  /** Most bytes in one tree node. */
  lineMax: number;
  /** The chat's view: batch-merge once it passes viewMax, down to viewMin. */
  viewMax: number;
  viewMin: number;
  /** The compaction view: the same sawtooth, smaller. */
  cviewMax: number;
  cviewMin: number;
  /** A tool's output is clipped to its head and tail, this many characters in all. */
  toolClip: number;
  /** Any other text longer than this is logged as several messages in a row. */
  splitChars: number;
  /** Compaction calls running at once. */
  concurrency: number;
  /** Tries per compaction to get a line under lineMax. */
  sizeTries: number;
  /** Lines per cache block in a rendered view. */
  blockLines: number;
  /** How long a turn waits for the compactor before going on with placeholders. */
  turnWaitMs: number;
  /** Prompt-cache entry lifetime (Anthropic API: 5 minutes from last read). */
  cacheTtlMs: number;
  turnModel: string;
  turnEffort: Effort;
  compactModel: string;
  compactEffort: Effort;
  /** Server-side refusal fallbacks on turns (Claude API only). */
  fallbacks: boolean;
  /** The agent's name, and the kind of its replies in the log. */
  name: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const defaults: Config = {
  lineMax: 512,
  viewMax: 128_000,
  viewMin: 64_000,
  cviewMax: 32_000,
  cviewMin: 16_000,
  toolClip: 30_000,
  splitChars: 30_000,
  concurrency: 8,
  sizeTries: 5,
  blockLines: 4,
  turnWaitMs: 120_000,
  cacheTtlMs: 5 * 60_000,
  turnModel: "claude-opus-5-5",
  turnEffort: "high",
  compactModel: "claude-haiku-5-5",
  compactEffort: "xhigh",
  fallbacks: true,
  name: "Orb",
};

const efforts = ["low", "medium", "high", "xhigh", "max"];

function effort(value: string | undefined, fallback: Effort): Effort {
  if (value === undefined) return fallback;
  if (!efforts.includes(value)) throw new Error(`bad effort "${value}": use one of ${efforts.join(", ")}`);
  return value as Effort;
}

/** Defaults, overridden by ORB_* environment variables. */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    ...defaults,
    turnModel: env.ORB_MODEL ?? defaults.turnModel,
    turnEffort: effort(env.ORB_EFFORT, defaults.turnEffort),
    compactModel: env.ORB_COMPACT_MODEL ?? defaults.compactModel,
    compactEffort: effort(env.ORB_COMPACT_EFFORT, defaults.compactEffort),
    fallbacks: env.ORB_FALLBACKS !== "off",
  };
}
