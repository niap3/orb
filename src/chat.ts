// One chat that never ends: the log, its tree of summaries, the views, and
// the compactor that builds the tree in the background.

import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Config } from "./config.ts";
import { CacheGate, type ModelClient, type StreamHandlers, prefixKey, viewBlocks } from "./model.ts";
import { leafTask, mergeTask, systemPrompt, tooLong } from "./prompt.ts";
import { type Kind, type Message, Store } from "./store.ts";
import { bytes, headBytes, split } from "./text.ts";
import { ToolError, tools } from "./tools.ts";
import { type Node, children, first, key, last, name, parent, parseName, sibling } from "./tree.ts";
import { View, renderLine } from "./view.ts";

export interface ChatOptions {
  dir: string;
  cfg: Config;
  client: ModelClient;
  /** Background trouble (a failed compaction): it is retried, so only reported. */
  warn?(message: string): void;
}

/** Models that take server-side refusal fallbacks. */
const FALLBACK_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

export class Chat {
  readonly cfg: Config;
  readonly store: Store;
  readonly messages: Message[];
  readonly view: View;
  readonly cview: View;
  readonly system: string;
  private readonly client: ModelClient;
  private readonly gate: CacheGate;
  private readonly nodes = new Map<string, string>();
  private readonly compactor: Compactor;
  readonly warn: (message: string) => void;

  constructor(opts: ChatOptions) {
    this.cfg = opts.cfg;
    this.client = opts.client;
    this.warn = opts.warn ?? (() => {});
    this.gate = new CacheGate(this.cfg.cacheTtlMs);
    this.store = new Store(opts.dir);
    this.messages = this.store.loadMessages();
    for (const r of this.store.loadNodes()) {
      if (r.i * 2 ** r.l < this.messages.length) this.nodes.set(key([r.l, r.i]), r.text);
    }
    this.system = systemPrompt(this.cfg, this.store.readInstructions());
    this.view = this.loadView("view.json", null);
    this.cview = this.loadView("cview.json", this.view);
    this.compactor = new Compactor(this);
    this.compactor.recover();
    this.maintain();
    this.compactor.pump();
  }

  /**
   * The saved view, never rebuilt (a rebuilt view differs from the live one,
   * and every cache entry dies). Only if it is missing or broken is one made:
   * the compaction view from the chat's view, the chat's view from leaves.
   */
  private loadView(file: "view.json" | "cview.json", from: View | null): View {
    const saved = this.store.loadView(file);
    let view: View | null = null;
    if (saved && this.covers(saved)) view = new View(this, saved);
    if (!view) {
      if (from) {
        view = new View(this, from.lines.slice());
        view.shrink(this.cfg.cviewMin, this.messages.length);
      } else {
        view = new View(this, []);
      }
      if (saved) this.warn(`${file} did not match the log; made a new one`);
    }
    // Messages logged after the last save (a crash): append their lines.
    for (let i = view.end(); i < this.messages.length; i++) view.append([0, i]);
    return view;
  }

  private covers(lines: readonly Node[]): boolean {
    let at = 0;
    for (const n of lines) {
      if (!Array.isArray(n) || first(n) !== at || n[0] < 0) return false;
      if (n[0] > 0 && this.text(n) === undefined) return false;
      at = last(n) + 1;
    }
    return at <= this.messages.length;
  }

  // --- the tree ---

  text(n: Node): string | undefined {
    return this.nodes.get(key(n));
  }

  /** Log a built node. Each node is built once, and never built again. */
  setNode(n: Node, text: string): void {
    if (this.nodes.has(key(n))) return;
    this.nodes.set(key(n), text);
    this.store.appendNode({ l: n[0], i: n[1], text, size: bytes(text) });
    const s = sibling(n);
    if (first(s) < this.messages.length && this.nodes.has(key(s)) && !this.nodes.has(key(parent(n)))) {
      this.compactor.mergeReady(parent(n));
    }
    this.compactor.built(n);
  }

  // --- the log ---

  /** Log a message; a long text goes in as several messages in a row. */
  log(kind: Kind, text: string): number[] {
    return split(text, this.cfg.splitChars).map((piece) => this.add(kind, piece));
  }

  private add(kind: Kind, text: string): number {
    const i = this.messages.length;
    const m: Message = { i, kind, text, size: bytes(text), date: new Date().toISOString() };
    this.messages.push(m);
    this.store.appendMessage(m);
    const source = `${kind}: ${text}`;
    if (bytes(source) <= this.cfg.lineMax) this.setNode([0, i], source);
    else this.compactor.leafReady(i);
    this.view.append([0, i]);
    this.cview.append([0, i]);
    this.maintain();
    this.compactor.retryFailed();
    this.compactor.pump();
    return i;
  }

  /**
   * Each message appends its line. Once the view passes its max, one batch
   * merges it down to its min; if parents aren't built yet, it merges what
   * it can at each message until it gets there. The compaction view does
   * the same, and also merges whenever the chat's view does.
   */
  private maintain(): void {
    const T = this.messages.length;
    let merged = false;
    if (this.view.shrinking || this.view.size() > this.cfg.viewMax) {
      merged = this.view.shrink(this.cfg.viewMin, T) > 0;
      this.view.shrinking = this.view.size() > this.cfg.viewMin;
    }
    if (merged || this.cview.shrinking || this.cview.size() > this.cfg.cviewMax) {
      this.cview.shrink(this.cfg.cviewMin, T);
      this.cview.shrinking = this.cview.size() > this.cfg.cviewMin;
    }
    this.store.saveView("view.json", this.view.lines);
    this.store.saveView("cview.json", this.cview.lines);
  }

  /** Whether every message has its line built. */
  summarized(): boolean {
    return this.compactor.unbuiltLeaves() === 0;
  }

  /** Wait until every message so far is summarized, or ms pass. Returns whether it is. */
  waitSummarized(ms: number): Promise<boolean> {
    return this.compactor.waitLeaves(ms);
  }

  /** Resolves once the compactor has nothing running or queued (failed work aside). */
  idle(): Promise<void> {
    return this.compactor.whenIdle();
  }

  stats() {
    return {
      messages: this.messages.length,
      nodes: this.nodes.size,
      viewLines: this.view.lines.length,
      viewBytes: this.view.size(),
      cviewLines: this.cview.lines.length,
      cviewBytes: this.cview.size(),
      ...this.compactor.stats(),
    };
  }

  // --- memory tools ---

  zoom(id: number, n: number): string {
    const node = parseName(id, n);
    if (typeof node === "string") throw new ToolError(node);
    if (id >= this.messages.length) throw new ToolError(`no message ${id}: the chat has ${this.messages.length} messages`);
    if (n === 1) {
      const m = this.messages[id];
      return `${m.kind}: ${m.text}`;
    }
    return children(node)
      .filter((c) => first(c) < this.messages.length)
      .map((c) => renderLine(c, this.text(c)))
      .join("\n");
  }

  date(id: number): string {
    const m = this.messages[id];
    if (!Number.isInteger(id) || !m) throw new ToolError(`no message ${id}: the chat has ${this.messages.length} messages`);
    return new Date(m.date).toString();
  }

  // --- calls ---

  /** [tools] [system] first, the same for every call, so all calls share them. */
  private base(): Pick<BetaMessageStreamParams, "system" | "tools" | "cache_control"> {
    return {
      system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
      tools,
      // One mark on the request's end (the system and the view carry the others).
      cache_control: { type: "ephemeral" },
    };
  }

  turnParams(messages: BetaMessageParam[]): BetaMessageStreamParams {
    const fallbacks = this.cfg.fallbacks && FALLBACK_MODELS.includes(this.cfg.turnModel);
    return {
      model: this.cfg.turnModel,
      max_tokens: 64_000,
      ...this.base(),
      messages,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: this.cfg.turnEffort },
      ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
  }

  compactParams(messages: BetaMessageParam[]): BetaMessageStreamParams {
    return {
      model: this.cfg.compactModel,
      max_tokens: 16_000,
      ...this.base(),
      messages,
      output_config: { effort: this.cfg.compactEffort },
    };
  }

  /** The view's lines as content blocks, ending "</chat>". */
  blocks(lines: readonly Node[]): BetaTextBlockParam[] {
    return viewBlocks(this.view.render(lines), this.cfg.blockLines);
  }

  /** One call, waiting first for any call that is writing the same view prefix. */
  async call(
    params: BetaMessageStreamParams,
    blocks: readonly BetaTextBlockParam[],
    handlers: StreamHandlers = {},
    signal?: AbortSignal,
  ): Promise<BetaMessage> {
    const release = await this.gate.enter(prefixKey(params.model, this.system, tools, blocks));
    let started = false;
    try {
      return await this.client.stream(
        params,
        {
          ...handlers,
          onStart: () => {
            started = true;
            release(true);
            handlers.onStart?.();
          },
        },
        signal,
      );
    } finally {
      if (!started) release(false);
    }
  }

  close(): void {
    this.store.close();
  }
}

type Job = { leaf: number } | { merge: Node };

/**
 * Builds the tree. Up to `concurrency` calls run at once. A message's node
 * starts once fewer than that many lines before it are still unbuilt; a
 * merge starts once both its halves are built. Ready work waits in queues:
 * the tree is never scanned for work (over a long chat, that is O(N²)).
 */
class Compactor {
  private readonly chat: Chat;
  /** Leaves that need a call, built or not yet, in order (running ones too). */
  private readonly unbuilt: number[] = [];
  private readonly leafQueue: number[] = [];
  private readonly mergeQueue: Node[] = [];
  private readonly queued = new Set<string>();
  private failed: Job[] = [];
  private running = 0;
  private waiters: (() => void)[] = [];
  private idlers: (() => void)[] = [];
  private calls = 0;

  constructor(chat: Chat) {
    this.chat = chat;
  }

  /** At start only: queue what the log says is unbuilt. */
  recover(): void {
    const { chat } = this;
    for (let i = 0; i < chat.messages.length; i++) {
      if (chat.text([0, i]) !== undefined) continue;
      const m = chat.messages[i];
      const source = `${m.kind}: ${m.text}`;
      if (bytes(source) <= chat.cfg.lineMax) chat.setNode([0, i], source);
      else this.leafReady(i);
    }
    // Merges: walk each level once, left to right.
    for (let l = 0, width = chat.messages.length; width >= 2; l++, width = Math.floor(width / 2)) {
      for (let i = 0; i + 1 < width; i += 2) {
        const a: Node = [l, i];
        if (chat.text(a) !== undefined && chat.text([l, i + 1]) !== undefined && chat.text(parent(a)) === undefined) {
          this.mergeReady(parent(a));
        }
      }
    }
  }

  leafReady(i: number): void {
    this.unbuilt.push(i);
    this.leafQueue.push(i);
  }

  mergeReady(p: Node): void {
    if (this.queued.has(key(p))) return;
    const [a, b] = children(p);
    const ta = this.chat.text(a)!;
    const tb = this.chat.text(b)!;
    const joined = `${ta}\n${tb}`;
    // Two short lines are joined by a newline, with no call.
    if (bytes(joined) <= this.chat.cfg.lineMax) return this.chat.setNode(p, joined);
    this.queued.add(key(p));
    this.mergeQueue.push(p);
  }

  built(n: Node): void {
    if (n[0] === 0) {
      const k = this.unbuilt.indexOf(n[1]);
      if (k >= 0) this.unbuilt.splice(k, 1);
      if (this.unbuilt.length === 0) for (const w of this.waiters.splice(0)) w();
    } else {
      this.queued.delete(key(n));
    }
  }

  unbuiltLeaves(): number {
    return this.unbuilt.length;
  }

  waitLeaves(ms: number): Promise<boolean> {
    if (this.unbuilt.length === 0) return Promise.resolve(true);
    return new Promise((done) => {
      const w = () => {
        clearTimeout(timer);
        done(true);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        done(this.unbuilt.length === 0);
      }, ms);
      this.waiters.push(w);
    });
  }

  /** A failed call is tried again at the next message. */
  retryFailed(): void {
    for (const job of this.failed.splice(0)) {
      if ("leaf" in job) {
        const k = this.leafQueue.findIndex((i) => i > job.leaf);
        this.leafQueue.splice(k < 0 ? this.leafQueue.length : k, 0, job.leaf);
      } else {
        this.mergeQueue.push(job.merge);
      }
    }
  }

  pump(): void {
    while (this.running < this.chat.cfg.concurrency) {
      const job = this.next();
      if (!job) break;
      this.running++;
      void this.run(job);
    }
  }

  private leafStartable(): boolean {
    const i = this.leafQueue[0];
    return i !== undefined && this.unbuilt.indexOf(i) < this.chat.cfg.concurrency;
  }

  private next(): Job | null {
    if (this.leafStartable()) return { leaf: this.leafQueue.shift()! };
    const p = this.mergeQueue.shift();
    return p ? { merge: p } : null;
  }

  private async run(job: Job): Promise<void> {
    try {
      if ("leaf" in job) await this.buildLeaf(job.leaf);
      else await this.buildMerge(job.merge);
    } catch (e) {
      this.failed.push(job);
      const what = "leaf" in job ? `message ${job.leaf}` : `line ${name(job.merge)}`;
      this.chat.warn(`compaction of ${what} failed (retried at the next message): ${(e as Error).message}`);
    } finally {
      this.running--;
      this.pump();
      if (this.isIdle()) for (const w of this.idlers.splice(0)) w();
    }
  }

  private isIdle(): boolean {
    return this.running === 0 && !this.leafStartable() && this.mergeQueue.length === 0;
  }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((done) => this.idlers.push(done));
  }

  private async buildLeaf(i: number): Promise<void> {
    const { chat } = this;
    const m = chat.messages[i];
    const line = await this.summarize(chat.cview.prefix(i - 1), leafTask(chat.cfg, i, m.kind, m.text));
    chat.setNode([0, i], line);
  }

  private async buildMerge(p: Node): Promise<void> {
    const { chat } = this;
    const [a, b] = children(p);
    const task = mergeTask(
      chat.cfg,
      name(a),
      name(b),
      first(p),
      last(p),
      renderLine(a, chat.text(a)),
      renderLine(b, chat.text(b)),
    );
    chat.setNode(p, await this.summarize(chat.cview.prefix(last(p)), task));
  }

  /**
   * [tools] [system] [<chat> compaction view </chat>] [task]. Models can't
   * count bytes, so the task shows a ruler; a line over the limit gets a cut
   * and another try, at most `sizeTries` in all, keeping the shortest.
   */
  private async summarize(context: Node[], task: string): Promise<string> {
    const { chat } = this;
    const { cfg } = chat;
    const blocks = chat.blocks(context);
    const messages: BetaMessageParam[] = [{ role: "user", content: [...blocks, { type: "text", text: task }] }];
    let best: string | undefined;
    for (let t = 0; t < cfg.sizeTries; t++) {
      this.calls++;
      const msg = await chat.call(chat.compactParams(messages), blocks);
      const line = msg.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("")
        .trim()
        .replace(/^\d+\+\d+\|\s*/, "");
      if (line && (best === undefined || bytes(line) < bytes(best))) best = line;
      if (line && bytes(line) <= cfg.lineMax) return line;
      if (msg.stop_reason === "refusal") break;
      messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
      const content: BetaContentBlockParam[] = msg.content.flatMap((b) =>
        b.type === "tool_use"
          ? [{ type: "tool_result" as const, tool_use_id: b.id, is_error: true, content: "Compactions call no tools." }]
          : [],
      );
      content.push({
        type: "text",
        text: line ? tooLong(cfg, bytes(line), headBytes(line, cfg.lineMax)) : "Output only the line.",
      });
      messages.push({ role: "user", content });
    }
    if (best === undefined) throw new Error("the model gave no line");
    return best;
  }

  stats() {
    return {
      unbuiltLeaves: this.unbuilt.length,
      queuedMerges: this.mergeQueue.length,
      running: this.running,
      failed: this.failed.length,
      calls: this.calls,
    };
  }
}
