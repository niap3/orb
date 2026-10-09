import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Chat } from "../src/chat.ts";
import { type Config, defaults } from "../src/config.ts";
import { CacheGate, type ModelClient, type StreamHandlers, viewBlocks } from "../src/model.ts";
import { bytes } from "../src/text.ts";
import { first, last } from "../src/tree.ts";
import { type Output, Turns } from "../src/turn.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orb-test-"));
}

function reply(content: BetaContentBlock[], stop: BetaMessage["stop_reason"] = "end_turn"): BetaMessage {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "fake",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as BetaMessage;
}

const text = (t: string) => ({ type: "text", text: t, citations: null }) as BetaContentBlock;

function lastText(messages: BetaMessageParam[]): string {
  const c = messages.at(-1)!.content;
  if (typeof c === "string") return c;
  const b = c.at(-1)!;
  return b.type === "text" ? b.text : "";
}

/** Compactions get a short line naming what they summarized. */
class FakeModel implements ModelClient {
  calls: BetaMessageStreamParams[] = [];
  turn: ((p: BetaMessageStreamParams) => BetaMessage | Promise<BetaMessage>) | null = null;
  compact: (p: BetaMessageStreamParams) => string = (p) => {
    const task = lastText(p.messages);
    const m = /Compaction: (compress message \d+|merge lines \S+ and \S+)/.exec(task);
    return `summary of ${m ? m[1] : "?"}: ${"x".repeat(300)}`;
  };
  async stream(p: BetaMessageStreamParams, h: StreamHandlers): Promise<BetaMessage> {
    this.calls.push(structuredClone(p));
    await new Promise((r) => setTimeout(r, 1));
    h.onStart?.();
    if (p.model === defaults.compactModel) return reply([text(this.compact(p))]);
    if (!this.turn) throw new Error("no turn script");
    return this.turn(p);
  }
}

const small: Config = {
  ...defaults,
  viewMax: 8_000,
  viewMin: 4_000,
  cviewMax: 3_000,
  cviewMin: 1_500,
  turnWaitMs: 5_000,
};

test("the tree and both views stay in shape over many messages", async () => {
  const dir = tmp();
  const model = new FakeModel();
  const chat = new Chat({ dir, cfg: small, client: model });
  const big = "y".repeat(600); // over 512 bytes: needs a compaction call
  // The compactor keeps up between messages, as it does between turns.
  let batches = 0;
  for (let k = 0; k < 600; k++) {
    const before = chat.view.lines.length;
    chat.log(k % 3 === 0 ? "user" : "echo", `${k} ${big}`);
    if (chat.view.lines.length < before) batches++;
    await chat.idle();
  }
  assert.ok(chat.summarized());

  for (const view of [chat.view, chat.cview]) {
    let at = 0;
    for (const n of view.lines) {
      assert.equal(first(n), at);
      at = last(n) + 1;
      const t = chat.text(n);
      assert.ok(t !== undefined, "every line is built");
      assert.ok(bytes(t) <= small.lineMax, `line too long: ${bytes(t)}`);
    }
    assert.equal(at, 600);
  }
  // A sawtooth: a few batches, not a merge at every message.
  assert.ok(batches > 0 && batches < 60, `batches: ${batches}`);
  assert.ok(chat.view.size() <= small.viewMax, `view ${chat.view.size()}`);
  assert.ok(chat.cview.size() <= small.cviewMax, `cview ${chat.cview.size()}`);
  assert.ok(chat.cview.lines.length < chat.view.lines.length);

  // Compactions send the same system prompt and tools as turns, and their
  // view only ever holds built lines.
  const c = model.calls[model.calls.length - 1];
  assert.equal((c.system as { text: string }[])[0].text, chat.system);
  assert.ok(c.tools && c.tools.length === 6);
  for (const call of model.calls) {
    const content = call.messages[0].content as { text: string }[];
    assert.ok(content[0].text.startsWith("<chat>\n"));
    assert.ok(!content.some((b) => b.text.includes("not summarized yet")));
  }

  // Restart: the view is loaded, not rebuilt, and nothing is built again.
  const lines = JSON.stringify(chat.view.lines);
  const nodes = chat.stats().nodes;
  chat.close();
  const before = model.calls.length;
  const again = new Chat({ dir, cfg: small, client: model });
  assert.equal(JSON.stringify(again.view.lines), lines);
  assert.equal(again.stats().nodes, nodes);
  await again.idle();
  assert.equal(model.calls.length, before);
  again.close();
});

test("short messages are their own lines, and short pairs join with no call", async () => {
  const model = new FakeModel();
  const chat = new Chat({ dir: tmp(), cfg: small, client: model });
  chat.log("user", "hi");
  chat.log("orb", "hello");
  await chat.idle();
  assert.equal(chat.text([0, 0]), "user: hi");
  assert.equal(chat.text([1, 0]), "user: hi\norb: hello");
  assert.equal(model.calls.length, 0);
  assert.equal(chat.view.render()[1], "1+1|orb: hello");
  chat.close();
});

test("a long text is logged as several messages in a row", () => {
  const chat = new Chat({ dir: tmp(), cfg: { ...small, splitChars: 1000 }, client: new FakeModel() });
  const ids = chat.log("user", "z".repeat(2500));
  assert.deepEqual(ids, [0, 1, 2]);
  assert.equal(chat.messages[2].text.length, 500);
  chat.close();
});

test("a line over the limit gets a cut and another try", async () => {
  const model = new FakeModel();
  const seen: string[] = [];
  model.compact = (p) => {
    seen.push(lastText(p.messages));
    return seen.length === 1 ? "w".repeat(700) : "short enough";
  };
  const chat = new Chat({ dir: tmp(), cfg: small, client: model });
  chat.log("user", "q".repeat(600));
  await chat.idle();
  assert.equal(chat.text([0, 0]), "short enough");
  assert.match(seen[0], /^Compaction: compress message 0 into one line of at most 512 bytes/);
  assert.ok(seen[0].includes("-".repeat(512)));
  assert.match(seen[1], /^Too long: your line is 700 bytes/);
  assert.ok(seen[1].endsWith("w".repeat(512) + "| ← LIMIT"));
  chat.close();
});

test("a failed compaction is tried again at the next message", async () => {
  const model = new FakeModel();
  let fail = true;
  const ok = model.compact;
  model.compact = (p) => {
    if (fail) throw new Error("overloaded");
    return ok(p);
  };
  const warnings: string[] = [];
  const chat = new Chat({ dir: tmp(), cfg: small, client: model, warn: (m) => warnings.push(m) });
  chat.log("user", "q".repeat(600));
  await chat.idle();
  assert.equal(chat.text([0, 0]), undefined);
  assert.equal(warnings.length, 1);
  fail = false;
  chat.log("user", "next");
  await chat.idle();
  assert.match(chat.text([0, 0])!, /^summary of compress message 0/);
  chat.close();
});

class Silent implements Output {
  events: string[] = [];
  start() {}
  thinking() {}
  text() {}
  toolCall(name: string) {
    this.events.push(`call ${name}`);
  }
  toolResult(name: string) {
    this.events.push(`result ${name}`);
  }
  delivered(t: string) {
    this.events.push(`delivered ${t}`);
  }
  notice(m: string) {
    this.events.push(`notice ${m}`);
  }
  end() {
    this.events.push("end");
  }
}

test("a turn: view, then the message; tool calls and results are logged", async () => {
  const model = new FakeModel();
  const chat = new Chat({ dir: tmp(), cfg: small, client: model });
  chat.log("user", "remember: the deploy key is in ~/keys/deploy");
  chat.log("orb", "noted");
  await chat.idle();

  const turnCalls: BetaMessageStreamParams[] = [];
  model.turn = (p) => {
    turnCalls.push(structuredClone(p));
    if (turnCalls.length === 1) {
      return reply(
        [text("Let me check."), { type: "tool_use", id: "tu_1", name: "zoom", input: { id: 0, n: 1 } } as BetaContentBlock],
        "tool_use",
      );
    }
    return reply([text("It is in ~/keys/deploy.")]);
  };
  const out = new Silent();
  const turns = new Turns(chat, out, "/work");
  await turns.send("where is the deploy key?");

  const kinds = chat.messages.map((m) => `${m.kind}: ${m.text.slice(0, 30)}`);
  assert.deepEqual(kinds.slice(2), [
    "user: where is the deploy key?",
    "orb: Let me check.",
    'tool: zoom {"id":0,"n":1}',
    "echo: user: remember: the deploy key",
    "orb: It is in ~/keys/deploy.",
  ]);
  const content = turnCalls[0].messages[0].content as { text: string; cache_control?: unknown }[];
  // The view excludes the new message, which goes whole after it.
  assert.equal(content.at(-2)!.text, "<chat>\n0+1|user: remember: the deploy key is in ~/keys/deploy\n1+1|orb: noted\n</chat>");
  assert.match(content.at(-1)!.text, /^\[.*; working directory: \/work\]\n\nwhere is the deploy key\?$/);
  assert.equal(turnCalls[0].thinking?.type, "adaptive");
  assert.deepEqual(turnCalls[1].messages.length, 3);
  assert.deepEqual(out.events, ["call zoom", "result zoom", "end"]);
  chat.close();
});

test("a message sent during a turn reaches it between tool calls", async () => {
  const model = new FakeModel();
  const chat = new Chat({ dir: tmp(), cfg: small, client: model });
  const turns = new Turns(chat, new Silent(), os.tmpdir());
  let n = 0;
  let second: BetaMessageStreamParams | null = null;
  model.turn = (p) => {
    n++;
    if (n === 1) {
      void turns.send("also check the logs");
      return reply([{ type: "tool_use", id: "tu_1", name: "shell", input: { command: "echo hi" } } as BetaContentBlock], "tool_use");
    }
    second = structuredClone(p);
    return reply([text("ok")]);
  };
  await turns.send("run it");
  await turns.done();
  assert.equal(n, 2, "one turn, not two");
  const last = second!.messages.at(-1)!.content as { type: string; text?: string; content?: string }[];
  assert.equal(last[0].type, "tool_result");
  assert.equal(last[0].content, "exit code 0\nhi\n");
  assert.match(last[1].text!, /also check the logs$/);
  assert.deepEqual(
    chat.messages.map((m) => m.kind),
    ["user", "tool", "echo", "user", "orb"],
  );
  chat.close();
});

test("one call writes a prefix while the others wait for its response", async () => {
  const gate = new CacheGate(60_000);
  const order: string[] = [];
  const r1 = await gate.enter("k");
  const p2 = gate.enter("k").then((r) => {
    order.push("second in");
    return r;
  });
  await new Promise((r) => setTimeout(r, 5));
  order.push("first starts");
  r1(true);
  const r2 = await p2;
  r2(true);
  assert.deepEqual(order, ["first starts", "second in"]);
  // A warm prefix lets the next calls straight through.
  const r3 = await gate.enter("k");
  const r4 = await gate.enter("k");
  r3(true);
  r4(true);
});

test("view blocks: 4 lines each, a mark on the last whole one", () => {
  const lines = Array.from({ length: 10 }, (_, k) => `${k}+1|line ${k}`);
  const blocks = viewBlocks(lines, 4);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[0].text.startsWith("<chat>\n0+1|line 0\n"));
  assert.ok(blocks[1].cache_control && !blocks[0].cache_control && !blocks[2].cache_control);
  assert.equal(blocks[2].text, "8+1|line 8\n9+1|line 9\n</chat>");
  assert.equal(blocks.map((b) => b.text).join(""), `<chat>\n${lines.join("\n")}\n</chat>`);
  // A longer view keeps the earlier blocks byte for byte: the cache holds.
  const longer = viewBlocks([...lines, "10+1|line 10", "11+1|line 11"], 4);
  assert.deepEqual(longer.slice(0, 2).map((b) => b.text), blocks.slice(0, 2).map((b) => b.text));
});

test("zoom and date", () => {
  const chat = new Chat({ dir: tmp(), cfg: small, client: new FakeModel() });
  for (let k = 0; k < 5; k++) chat.log("user", `m${k}`);
  assert.equal(chat.zoom(4, 1), "user: m4");
  assert.equal(chat.zoom(0, 4), "0+2|user: m0 user: m1\n2+2|user: m2 user: m3");
  assert.equal(chat.zoom(4, 4), "4+2|(not summarized yet: zoom it)");
  assert.throws(() => chat.zoom(3, 2), /multiple of n/);
  assert.throws(() => chat.zoom(0, 3), /power of 2/);
  assert.throws(() => chat.zoom(9, 1), /no message 9/);
  assert.match(chat.date(0), /\d{4}/);
  chat.close();
});

test("one process owns a chat", () => {
  const dir = tmp();
  const chat = new Chat({ dir, cfg: small, client: new FakeModel() });
  // Same pid: the lock reads as ours and stale; a live other pid is refused.
  fs.writeFileSync(path.join(dir, "lock"), String(process.ppid));
  assert.throws(() => new Chat({ dir, cfg: small, client: new FakeModel() }), /another process/);
  chat.close();
});
