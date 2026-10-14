// A turn: each user message starts a fresh call that sees [tools] [system]
// [view] [message]. Nothing carries over between turns: the view is the only
// continuity. Messages the user sends meanwhile reach it between tool calls.

import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Chat } from "./chat.ts";
import { type ClaudeSession, resultText, toolName } from "./claudecode.ts";
import { clip } from "./text.ts";
import { ToolError, runTool } from "./tools.ts";

export interface Output {
  /** A turn starts. */
  start(): void;
  thinking(delta: string): void;
  text(delta: string): void;
  toolCall(name: string, input: unknown): void;
  toolResult(name: string, result: string, isError: boolean): void;
  /** A user message handed to the running turn. */
  delivered(text: string): void;
  notice(message: string): void;
  /** The turn is over (done, failed or interrupted). */
  end(): void;
}

export class Turns {
  private readonly chat: Chat;
  private readonly out: Output;
  private readonly cwd: string;
  private readonly iface: "browser" | "terminal";
  private inbox: string[] = [];
  private running = false;
  private abort: AbortController | null = null;
  /** A running Claude Code turn, and how many user messages it has been sent. */
  private live: ClaudeSession | null = null;
  private liveSent = 0;
  private idle: Promise<void> = Promise.resolve();

  constructor(chat: Chat, out: Output, cwd = process.cwd(), iface: "browser" | "terminal" = "terminal") {
    this.chat = chat;
    this.out = out;
    this.cwd = cwd;
    this.iface = iface;
  }

  get busy(): boolean {
    return this.running;
  }

  /** A user message: starts a turn, or reaches the running one between tool calls. */
  send(text: string): Promise<void> {
    if (this.live) {
      // Claude Code takes it between tool calls itself.
      this.chat.log("user", text);
      this.out.delivered(text);
      this.live.send(this.header() + text);
      this.liveSent++;
      return this.idle;
    }
    this.inbox.push(text);
    if (!this.running) this.idle = this.drain();
    return this.idle;
  }

  /** Stop the running turn. Messages already logged stay logged. */
  interrupt(): void {
    this.abort?.abort();
    this.live?.interrupt();
  }

  /** Resolves once no turn is running. */
  done(): Promise<void> {
    return this.idle;
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let m = this.inbox.shift(); m !== undefined; m = this.inbox.shift()) {
        await this.turn(m);
      }
    } finally {
      this.running = false;
    }
  }

  /** Per-turn state goes after the view, never in the system prompt. */
  private header(): string {
    return `[${new Date().toString()}; working directory: ${this.cwd}; interface: ${this.iface}]\n\n`;
  }

  private async turn(m: string): Promise<void> {
    if (this.chat.cc) return this.ccTurn(m);
    const { chat, out } = this;
    const abort = (this.abort = new AbortController());
    out.start();
    const agent = chat.cfg.name.toLowerCase();
    try {
      // Wait until every message before m is summarized (the compactor
      // working through the last turn's messages: seconds, usually).
      if (!(await chat.waitSummarized(chat.cfg.turnWaitMs))) {
        out.notice("some messages are not summarized yet; going on without them (they show as placeholders)");
      }
      // Render the view before logging the new message; it goes whole after it.
      const blocks = chat.blocks(chat.view.lines);
      chat.log("user", m);
      const messages: BetaMessageParam[] = [
        { role: "user", content: [...blocks, { type: "text", text: this.header() + m }] },
      ];
      for (;;) {
        const msg = await chat.call(
          chat.turnParams(messages),
          blocks,
          { onThinking: (d) => out.thinking(d), onText: (d) => out.text(d) },
          abort.signal,
        );
        // Log each reply and tool call as it happens. Thoughts are shown, never logged.
        const uses: BetaToolUseBlock[] = [];
        for (const b of msg.content) {
          if (b.type === "text" && b.text.trim()) chat.log(agent, b.text);
          if (b.type === "tool_use") {
            chat.log("tool", `${b.name} ${JSON.stringify(b.input)}`);
            uses.push(b);
          }
          if (b.type === "fallback") out.notice(`${b.from.model} declined; ${b.to.model} continued`);
        }
        if (msg.stop_reason === "refusal") {
          out.notice("the model declined to continue this turn");
          break;
        }
        messages.push({ role: "assistant", content: msg.content as BetaContentBlockParam[] });
        if (msg.stop_reason === "pause_turn") continue;
        if (uses.length === 0) break;

        const content: BetaContentBlockParam[] = [];
        for (const u of uses) {
          out.toolCall(u.name, u.input);
          let result: string;
          let isError = false;
          if (msg.stop_reason === "max_tokens") {
            // A tool input cut off at max_tokens can still look whole: never run it.
            result = "error: this call was cut off at max_tokens and did not run";
            isError = true;
          } else {
            try {
              result = await runTool(u.name, (u.input ?? {}) as Record<string, unknown>, chat, this.cwd, abort.signal);
            } catch (e) {
              if (!(e instanceof ToolError)) throw e;
              result = `error: ${e.message}`;
              isError = true;
            }
          }
          // A tool's output is clipped to its head and tail.
          result = clip(result, chat.cfg.toolClip);
          chat.log("echo", result);
          out.toolResult(u.name, result, isError);
          content.push({ type: "tool_result", tool_use_id: u.id, content: result, is_error: isError || undefined });
          if (abort.signal.aborted) throw abort.signal.reason;
        }
        // Messages the user sent meanwhile reach the turn here.
        for (let next = this.inbox.shift(); next !== undefined; next = this.inbox.shift()) {
          chat.log("user", next);
          out.delivered(next);
          content.push({ type: "text", text: this.header() + next });
        }
        messages.push({ role: "user", content });
      }
    } catch (e) {
      if (abort.signal.aborted) out.notice("interrupted");
      else out.notice(`turn failed: ${(e as Error).message}`);
    } finally {
      this.abort = null;
      out.end();
    }
  }

  /**
   * A turn through Claude Code: the same view and message, in a fresh
   * `claude -p` run. Its events are logged as they come, like the API's.
   */
  private async ccTurn(m: string): Promise<void> {
    const { chat, out } = this;
    const cc = chat.cc!;
    const agent = chat.cfg.name.toLowerCase();
    const abort = (this.abort = new AbortController());
    out.start();
    let s: ClaudeSession | null = null;
    try {
      if (!(await chat.waitSummarized(chat.cfg.turnWaitMs))) {
        out.notice("some messages are not summarized yet; going on without them (they show as placeholders)");
      }
      const blocks = chat.blocks(chat.view.lines).map((b) => ({ type: "text" as const, text: b.text }));
      chat.log("user", m);
      if (abort.signal.aborted) throw abort.signal.reason;
      s = cc.session(await cc.turnArgs(this.cwd), this.cwd);
      this.live = s;
      this.liveSent = 1;
      s.send([...blocks, { type: "text", text: this.header() + m }]);
      let acked = 0;
      const names = new Map<string, string>();
      for await (const e of s.events()) {
        if (e.parent_tool_use_id) continue; // a subagent's inner steps
        switch (e.type) {
          case "stream_event": {
            const ev = e.event;
            if (ev?.type !== "content_block_delta") break;
            if (ev.delta?.type === "text_delta") out.text(ev.delta.text);
            else if (ev.delta?.type === "thinking_delta") out.thinking(ev.delta.thinking);
            break;
          }
          case "assistant":
            // Log each reply and tool call as it happens. Thoughts are shown, never logged.
            for (const b of e.message?.content ?? []) {
              if (b.type === "text" && b.text.trim()) chat.log(agent, b.text);
              if (b.type === "tool_use") {
                const name = toolName(b.name);
                names.set(b.id, name);
                chat.log("tool", `${name} ${JSON.stringify(b.input)}`);
                out.toolCall(name, b.input);
              }
            }
            break;
          case "user": {
            const content = e.message?.content;
            const results = Array.isArray(content) ? content.filter((b: { type: string }) => b.type === "tool_result") : [];
            if (results.length === 0) {
              acked++; // one of our messages, read by Claude Code
              break;
            }
            for (const r of results) {
              const text = clip(resultText(r.content), chat.cfg.toolClip);
              chat.log("echo", text);
              out.toolResult(names.get(r.tool_use_id) ?? "tool", text, !!r.is_error);
            }
            break;
          }
          case "result":
            if (e.is_error && !abort.signal.aborted) out.notice(`claude: ${e.result || e.subtype}`);
            // Done once it has read every message sent; a message that came
            // after it finished starts another answer in the same run.
            if (acked === 0 || acked >= this.liveSent) s.end();
            break;
          case "system":
            if (e.subtype === "api_retry") out.notice(`retrying (${e.error}, attempt ${e.attempt})`);
            break;
        }
      }
      const { code, stderr } = await s.exit();
      if (abort.signal.aborted) out.notice("interrupted");
      else if (code !== 0) out.notice(`claude exited with ${code}${stderr ? `: ${stderr.split("\n").slice(-3).join(" ")}` : ""}`);
    } catch (e) {
      if (abort.signal.aborted) out.notice("interrupted");
      else out.notice(`turn failed: ${(e as Error).message}`);
    } finally {
      s?.end();
      this.live = null;
      this.abort = null;
      out.end();
    }
  }
}
