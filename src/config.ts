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
  /**
   * Where calls go: "api" calls the Claude API with an API key; "claude-code"
   * runs the `claude` program, signed in to the user's own Claude account.
   */
  backend: "api" | "claude-code";
  /** The `claude` program, for the claude-code backend. */
  claudeBin: string;
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
  backend: "api",
  claudeBin: "claude",
};

const efforts = ["low", "medium", "high", "xhigh", "max"];

function effort(value: string | undefined, fallback: Effort): Effort {
  if (value === undefined) return fallback;
  if (!efforts.includes(value)) throw new Error(`bad effort "${value}": use one of ${efforts.join(", ")}`);
  return value as Effort;
}

/**
 * The backend: ORB_BACKEND if set; otherwise the API when an API key is
 * set, and Claude Code (the user's subscription) when not.
 */
function backend(env: NodeJS.ProcessEnv): Config["backend"] {
  const b = env.ORB_BACKEND;
  if (b === "api" || b === "claude-code") return b;
  if (b !== undefined) throw new Error(`bad ORB_BACKEND "${b}": use api or claude-code`);
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "api" : "claude-code";
}

/** Defaults, overridden by ORB_* environment variables. */
export function fromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const b = backend(env);
  return {
    ...defaults,
    backend: b,
    claudeBin: env.ORB_CLAUDE ?? defaults.claudeBin,
    // Each Claude Code compaction is a whole program run: fewer at once.
    concurrency: b === "claude-code" ? 3 : defaults.concurrency,
    turnModel: env.ORB_MODEL ?? defaults.turnModel,
    turnEffort: effort(env.ORB_EFFORT, defaults.turnEffort),
    compactModel: env.ORB_COMPACT_MODEL ?? defaults.compactModel,
    compactEffort: effort(env.ORB_COMPACT_EFFORT, defaults.compactEffort),
    fallbacks: env.ORB_FALLBACKS !== "off",
  };
}
