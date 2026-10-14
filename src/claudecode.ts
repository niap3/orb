// The Claude Code engine: Orb's calls go through the `claude` program on the
// user's computer, signed in to their own Claude account, instead of
// straight to the API. Orb keeps its memory, view and system prompt;
// Claude Code runs the model, its own shell and file tools, and Orb's zoom,
// date and ui tools over a local MCP server.
//
// Each turn and each compaction is a fresh `claude -p` run, talking
// stream-json on stdin and stdout. Nothing is saved on Claude Code's side.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { Config } from "./config.ts";
import { ToolError } from "./errors.ts";
import { type McpServer, startMcp } from "./mcp.ts";
import { type Memory, runTool, tools } from "./tools.ts";

/** Orb's own tools, served to Claude Code; its built-ins do shell and files. */
const ORB_TOOLS = ["zoom", "date", "ui"];
export const BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit"];
const MCP_NAME = "orb";

export type TextBlock = { type: "text"; text: string };

/** One `claude -p` run in stream-json mode. */
export class ClaudeSession {
  private readonly child: ChildProcess;
  private readonly lines: AsyncIterator<string>;
  private stderr = "";
  private readonly exited: Promise<number | null>;

  constructor(bin: string, args: string[], cwd: string) {
    this.child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.child.stderr!.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString("utf8")).slice(-4000);
    });
    this.exited = new Promise((done) => {
      this.child.on("error", (e) => {
        this.stderr += `\n${e.message}`;
        done(null);
      });
      this.child.on("close", (code) => done(code));
    });
    this.lines = readline.createInterface({ input: this.child.stdout! })[Symbol.asyncIterator]();
    // A closed stdin (the run ended early) must not crash Orb.
    this.child.stdin!.on("error", () => {});
  }

  send(content: string | TextBlock[]): void {
    const line = JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
    this.child.stdin!.write(line + "\n");
  }

  /** No more input: the run ends once it has answered what it has. */
  end(): void {
    this.child.stdin!.end();
  }

  /** Stop the turn in progress (SIGINT ends it cleanly). */
  interrupt(): void {
    this.child.kill("SIGINT");
  }

  /** The run's events, one parsed JSON object per line, until it exits. */
  async *events(): AsyncGenerator<Record<string, any>> {
    for (;;) {
      const { value, done } = await this.lines.next();
      if (done) break;
      if (!value.trim()) continue;
      try {
        yield JSON.parse(value);
      } catch {
        // Not an event (a stray log line): skip it.
      }
    }
  }

  /** Wait for exit; the exit code, and the end of stderr to explain a failure. */
  async exit(): Promise<{ code: number | null; stderr: string }> {
    return { code: await this.exited, stderr: this.stderr.trim() };
  }
}

/** The text of a tool_result's content, which is a string or a list of blocks. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && b.type === "text" ? b.text : b && b.type === "image" ? "[image]" : "")).join("\n");
  }
  return "";
}

/** Orb's name for a tool: its own tools lose the MCP prefix. */
export function toolName(name: string): string {
  return name.startsWith(`mcp__${MCP_NAME}__`) ? name.slice(`mcp__${MCP_NAME}__`.length) : name;
}

export class ClaudeCode {
  private readonly cfg: Config;
  private readonly bin: string;
  private readonly promptFile: string;
  private readonly memory: Memory;
  private mcp: McpServer | null = null;

  constructor(cfg: Config, dir: string, system: string, memory: Memory, bin = "claude") {
    this.cfg = cfg;
    this.bin = bin;
    this.memory = memory;
    // The system prompt goes in a file: it is long, and the same every run.
    this.promptFile = path.join(dir, "system-prompt.txt");
    fs.writeFileSync(this.promptFile, system);
  }

  private common(model: string, effort: string): string[] {
    return [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--system-prompt-file", this.promptFile,
      "--model", model,
      "--effort", effort,
      "--no-session-persistence",
    ];
  }

  /** Arguments for a compaction: no tools at all. */
  compactionArgs(): string[] {
    return [...this.common(this.cfg.compactModel, this.cfg.compactEffort), "--tools", "", "--strict-mcp-config"];
  }

  /** Arguments for a turn: Claude Code's shell and file tools, and Orb's own over MCP. */
  async turnArgs(cwd: string): Promise<string[]> {
    if (!this.mcp) {
      this.mcp = await startMcp(
        tools.filter((t) => ORB_TOOLS.includes(t.name)),
        async (name, args) => {
          try {
            return { text: await runTool(name, args, this.memory, cwd), isError: false };
          } catch (e) {
            if (e instanceof ToolError) return { text: `error: ${e.message}`, isError: true };
            throw e;
          }
        },
      );
    }
    const allowed = [...BUILTIN_TOOLS, ...ORB_TOOLS.map((t) => `mcp__${MCP_NAME}__${t}`)];
    return [
      ...this.common(this.cfg.turnModel, this.cfg.turnEffort),
      "--include-partial-messages",
      "--replay-user-messages",
      "--tools", BUILTIN_TOOLS.join(","),
      "--mcp-config", JSON.stringify({ mcpServers: { [MCP_NAME]: this.mcp.config } }),
      "--strict-mcp-config",
      "--allowedTools", allowed.join(","),
      // Calls the allow list covers run; anything else is denied, never left
      // waiting for an answer nobody can give.
      "--permission-mode", "dontAsk",
    ];
  }

  session(args: string[], cwd: string): ClaudeSession {
    return new ClaudeSession(this.bin, args, cwd);
  }

  /**
   * A compaction: the view and the task as one message, then the "Too long"
   * follow-ups in the same run. Returns each reply's text in turn to
   * `check`, which says what to send next, or null to stop.
   */
  async compact(content: TextBlock[], check: (reply: string) => string | null, cwd: string): Promise<void> {
    const s = this.session(this.compactionArgs(), cwd);
    s.send(content);
    let finished = false;
    try {
      for await (const e of s.events()) {
        if (e.type !== "result") continue;
        if (e.is_error) throw new Error(`claude: ${e.result ?? e.subtype}`);
        const next = check(String(e.result ?? ""));
        if (next === null) {
          finished = true;
          break;
        }
        s.send(next);
      }
    } finally {
      s.end();
      const { code, stderr } = await s.exit();
      if (!finished && code !== 0) throw new Error(`claude exited with ${code}${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`);
    }
  }

  async close(): Promise<void> {
    await this.mcp?.close();
    this.mcp = null;
  }
}
