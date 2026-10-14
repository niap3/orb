// Calls to the model, and the cache-write gate.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

export interface StreamHandlers {
  /** The response has started: its prefix is in the cache now. */
  onStart?(): void;
  onThinking?(delta: string): void;
  onText?(delta: string): void;
}

export interface ModelClient {
  stream(params: BetaMessageStreamParams, handlers: StreamHandlers, signal?: AbortSignal): Promise<BetaMessage>;
}

export class AnthropicClient implements ModelClient {
  private readonly client: Anthropic;
  constructor(client = new Anthropic()) {
    this.client = client;
  }
  async stream(params: BetaMessageStreamParams, h: StreamHandlers, signal?: AbortSignal): Promise<BetaMessage> {
    const s = this.client.beta.messages.stream(params, { signal });
    let started = false;
    const start = () => {
      if (!started) {
        started = true;
        h.onStart?.();
      }
    };
    s.on("streamEvent", start);
    if (h.onThinking) s.on("thinking", (delta) => h.onThinking!(delta));
    if (h.onText) s.on("text", (delta) => h.onText!(delta));
    return await s.finalMessage();
  }
}

/**
 * A call whose marked prefix another call is writing waits until that call's
 * response starts; otherwise both pay to write it. Compactions start up to 8
 * at a time on one prefix, so this matters.
 */
export class CacheGate {
  private readonly writing = new Map<string, Promise<void>>();
  private readonly warm = new Map<string, number>();
  private readonly ttl: number;

  constructor(ttlMs: number) {
    this.ttl = ttlMs;
  }

  /** Wait for any writer of key; returns a release to call once the response starts. */
  async enter(key: string): Promise<(ok: boolean) => void> {
    for (let w = this.writing.get(key); w; w = this.writing.get(key)) await w;
    const now = Date.now();
    const seen = this.warm.get(key);
    if (seen !== undefined && now - seen < this.ttl) {
      // A read: it refreshes the entry, and writes nothing.
      return (ok) => {
        if (ok) this.warm.set(key, Date.now());
      };
    }
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    this.writing.set(key, p);
    return (ok) => {
      if (this.writing.get(key) === p) this.writing.delete(key);
      if (ok) this.warm.set(key, Date.now());
      this.prune();
      release();
    };
  }

  private prune(): void {
    if (this.warm.size < 1000) return;
    const now = Date.now();
    for (const [k, t] of this.warm) if (now - t >= this.ttl) this.warm.delete(k);
  }
}

/**
 * The view as content blocks: 4 lines a block, one cache mark on the last
 * whole block. The next call finds this mark (Anthropic looks back up to 20
 * blocks from a mark) and pays only for the lines after it.
 */
export function viewBlocks(lines: readonly string[], blockLines: number): BetaTextBlockParam[] {
  const whole = Math.floor(lines.length / blockLines);
  const blocks: BetaTextBlockParam[] = [];
  for (let k = 0; k < whole; k++) {
    const chunk = lines.slice(k * blockLines, (k + 1) * blockLines).join("\n") + "\n";
    blocks.push({ type: "text", text: (k === 0 ? "<chat>\n" : "") + chunk });
  }
  if (whole > 0) blocks[whole - 1].cache_control = { type: "ephemeral" };
  const rest = lines.slice(whole * blockLines);
  const tail = rest.length ? rest.join("\n") + "\n" : "";
  blocks.push({ type: "text", text: (whole === 0 ? "<chat>\n" : "") + tail + "</chat>" });
  return blocks;
}

/** A key for everything up to the view's cache mark. */
export function prefixKey(model: string, system: string, tools: unknown, blocks: readonly BetaTextBlockParam[]): string {
  const h = createHash("sha256").update(model).update("\0").update(system).update("\0").update(JSON.stringify(tools));
  const marked = blocks.findLastIndex((b) => b.cache_control);
  for (let k = 0; k <= marked; k++) h.update("\0").update(blocks[k].text);
  return h.digest("hex");
}
