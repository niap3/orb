// orb: one chat that never ends, in the terminal.
//
//   orb                  chat (the chat lives in $ORB_DIR, or ~/.orb)
//   orb web [port]       chat in the browser (default port 4747)
//   orb note [file]      import memories from before the chat, one per paragraph
//   orb stats            sizes of the log, the tree and the views
//   orb view             print the view, as the model sees it

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Chat } from "./chat.ts";
import { type Config, fromEnv } from "./config.ts";
import { AnthropicClient } from "./model.ts";
import { type Output, Turns } from "./turn.ts";
import { type Block, uiText } from "./ui.ts";
import { serve } from "./web.ts";

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const cyan = paint("36");
const yellow = paint("33");

const HELP = `orb: one chat that never ends

  orb                  chat in the terminal
  orb web [port]       chat in the browser, at http://127.0.0.1:4747
  orb note [file]      import notes (memories from before the chat), one per
                       paragraph, from file or stdin
  orb stats            sizes of the log, the tree and the views
  orb view             print the view, as the model sees it

The chat lives in $ORB_DIR (default ~/.orb). Put your instructions (who you
are, how your files are organized, how you want work done) in
$ORB_DIR/instructions.md.

Orb runs on your Claude subscription through Claude Code (install it and run
\`claude auth login\` once), or on the Claude API if ANTHROPIC_API_KEY is set.
Pick one explicitly with ORB_BACKEND=claude-code or ORB_BACKEND=api.

Environment: ANTHROPIC_API_KEY, ORB_BACKEND, ORB_CLAUDE (path to claude),
ORB_DIR, ORB_MODEL, ORB_EFFORT, ORB_COMPACT_MODEL, ORB_COMPACT_EFFORT,
ORB_FALLBACKS=off.

In the chat: /stats, /view, /zoom id n, /quit. Ctrl-C stops a running turn.
Messages you send while a turn runs reach it between tool calls.`;

/**
 * With the claude-code backend: check that Claude Code is installed and
 * signed in, and say which account pays. Throws with what to do if not.
 */
function checkClaudeCode(cfg: Config): string {
  const r = spawnSync(cfg.claudeBin, ["auth", "status"], { encoding: "utf8" });
  if (r.error) {
    throw new Error(
      `Orb uses Claude Code to reach your Claude account, but "${cfg.claudeBin}" wasn't found.\n` +
        "Install Claude Code (https://code.claude.com/docs/en/setup), run `claude auth login`, and start Orb again.\n" +
        "Or set ANTHROPIC_API_KEY to use the API instead.",
    );
  }
  let status: { loggedIn?: boolean; authMethod?: string } = {};
  try {
    status = JSON.parse(r.stdout);
  } catch {
    // An older Claude Code: go by the exit code.
  }
  if (r.status !== 0 || status.loggedIn === false) {
    throw new Error("Claude Code isn't signed in. Run `claude auth login`, then start Orb again.");
  }
  switch (status.authMethod) {
    case "claude.ai":
    case "oauth_token":
      return "Claude Code, on your Claude subscription";
    case "api_key":
    case "api_key_helper":
      return "Claude Code, on an API key (billed per use, not your subscription)";
    default:
      return "Claude Code";
  }
}

let via = "";

function open(): Chat {
  const dir = process.env.ORB_DIR ?? path.join(os.homedir(), ".orb");
  const cfg = fromEnv();
  via = cfg.backend === "claude-code" ? checkClaudeCode(cfg) : "the Claude API";
  return new Chat({
    dir,
    cfg,
    // The claude-code backend never calls the API itself.
    client: cfg.backend === "api" ? new AnthropicClient() : { stream: () => Promise.reject(new Error("no API client")) },
    warn: (m) => process.stderr.write(yellow(`[orb] ${m}`) + "\n"),
  });
}

function summarize(input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const s =
    typeof o.command === "string"
      ? o.command
      : typeof o.path === "string" || typeof o.file_path === "string"
        ? String(o.path ?? o.file_path)
        : "id" in o
          ? `${o.id}${"n" in o ? `+${o.n}` : ""}`
          : JSON.stringify(o);
  const one = s.replace(/\s+/g, " ");
  return one.length > 100 ? one.slice(0, 99) + "…" : one;
}

class TerminalOutput implements Output {
  private mode: "none" | "thinking" | "text" = "none";
  private readonly rl: readline.Interface;
  constructor(rl: readline.Interface) {
    this.rl = rl;
  }
  private switchTo(mode: "none" | "thinking" | "text"): void {
    if (this.mode !== mode && this.mode !== "none") process.stdout.write("\n");
    if (this.mode !== mode && mode === "thinking") process.stdout.write(dim("∴ "));
    this.mode = mode;
  }
  start(): void {}
  thinking(d: string): void {
    this.switchTo("thinking");
    process.stdout.write(dim(d));
  }
  text(d: string): void {
    this.switchTo("text");
    process.stdout.write(d);
  }
  toolCall(name: string, input: unknown): void {
    this.switchTo("none");
    if (name === "ui") {
      const blocks = (input as { blocks?: Block[] }).blocks;
      try {
        process.stdout.write(uiText(blocks ?? []) + "\n");
        return;
      } catch {
        // A malformed call: the tool reports it; show it as a call.
      }
    }
    process.stdout.write(cyan(`● ${name}(${summarize(input)})`) + "\n");
  }
  toolResult(name: string, result: string, isError: boolean): void {
    if (name === "ui" && !isError) return;
    const lines = result.split("\n");
    const shown = lines.slice(0, 4).map((l) => (l.length > 160 ? l.slice(0, 159) + "…" : l));
    if (lines.length > 4) shown.push(`… ${lines.length - 4} more lines`);
    const text = shown.map((l, k) => `${k === 0 ? "  ⎿ " : "    "}${l}`).join("\n");
    process.stdout.write((isError ? yellow(text) : dim(text)) + "\n");
  }
  delivered(text: string): void {
    this.switchTo("none");
    process.stdout.write(dim(`(sent to the running turn: ${summarize({ command: text })})`) + "\n");
  }
  notice(message: string): void {
    this.switchTo("none");
    process.stdout.write(yellow(`[${message}]`) + "\n");
  }
  end(): void {
    this.switchTo("none");
    process.stdout.write("\n");
    this.rl.prompt();
  }
}

function printStats(chat: Chat): void {
  const s = chat.stats();
  console.log(
    [
      `messages        ${s.messages}`,
      `tree nodes      ${s.nodes}`,
      `view            ${s.viewLines} lines, ${s.viewBytes} bytes`,
      `compaction view ${s.cviewLines} lines, ${s.cviewBytes} bytes`,
      `compactor       ${s.running} running, ${s.unbuiltLeaves} messages unsummarized, ${s.queuedMerges} merges queued, ${s.failed} failed`,
    ].join("\n"),
  );
}

async function repl(): Promise<void> {
  const chat = open();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
  const turns = new Turns(chat, new TerminalOutput(rl));
  const s = chat.stats();
  console.log(dim(`orb: ${s.messages} messages in ${chat.store.dir}, via ${via}. /quit to leave.`));
  rl.prompt();

  let lastSigint = 0;
  rl.on("SIGINT", () => {
    if (turns.busy) return turns.interrupt();
    if (Date.now() - lastSigint < 2000) return rl.close();
    lastSigint = Date.now();
    console.log(dim("\n(Ctrl-C again to quit)"));
    rl.prompt();
  });

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === "/quit" || text === "/exit") return rl.close();
    if (text === "/stats") {
      printStats(chat);
      return rl.prompt();
    }
    if (text === "/view") {
      console.log(chat.view.render().join("\n"));
      return rl.prompt();
    }
    const z = /^\/zoom\s+(\d+)\s+(\d+)$/.exec(text);
    if (z) {
      try {
        console.log(chat.zoom(Number(z[1]), Number(z[2])));
      } catch (e) {
        console.log(yellow((e as Error).message));
      }
      return rl.prompt();
    }
    void turns.send(text);
  });

  await new Promise<void>((done) => rl.on("close", done));
  turns.interrupt();
  await turns.done();
  chat.close();
  process.exit(0);
}

async function web(portArg: string | undefined): Promise<void> {
  const port = portArg === undefined ? Number(process.env.ORB_PORT ?? 4747) : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad port: ${portArg}`);
  const chat = open();
  const server = await serve({ chat, port });
  console.log(`orb is running, via ${via}. Open this link (it holds your access token):\n\n  ${server.url}\n`);
  console.log(dim("Ctrl-C to stop."));
  const stop = async () => {
    await server.close();
    chat.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function note(file: string | undefined): Promise<void> {
  const text = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  const notes = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chat = open();
  for (const n of notes) chat.log("note", n);
  console.log(`logged ${notes.length} notes; summarizing…`);
  await chat.waitSummarized(10 * 60_000);
  await chat.idle();
  printStats(chat);
  chat.close();
  process.exit(0);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
      return repl();
    case "web":
      return web(arg);
    case "note":
      return note(arg);
    case "stats": {
      const chat = open();
      printStats(chat);
      chat.close();
      return process.exit(0);
    }
    case "view": {
      const chat = open();
      console.log(chat.view.render().join("\n"));
      chat.close();
      return process.exit(0);
    }
    case "-h":
    case "--help":
    case "help":
      return console.log(HELP);
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
