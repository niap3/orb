import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Chat } from "../src/chat.ts";
import { defaults } from "../src/config.ts";
import { fromEnv } from "../src/config.ts";
import { type Output, Turns } from "../src/turn.ts";

function fakeClaude(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-fake-claude-"));
  const bin = path.join(dir, "claude");
  const script = new URL("./fixtures/fake-claude.mjs", import.meta.url).pathname;
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

const noClient = { stream: () => Promise.reject(new Error("no API client")) };

test("claude-code backend: summaries and a turn go through `claude -p`", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-cc-"));
  const cfg = { ...defaults, backend: "claude-code" as const, claudeBin: fakeClaude() };
  const chat = new Chat({ dir, cfg, client: noClient });
  // A long message needs a compaction: long first, then the cut retry.
  chat.log("user", "the code is " + "4242 ".repeat(200));
  await chat.idle();
  assert.equal(chat.text([0, 0]), "short line");
  assert.match(fs.readFileSync(path.join(dir, "system-prompt.txt"), "utf8"), /^You are Orb/);

  const events: string[] = [];
  const out: Output = {
    start: () => events.push("start"),
    thinking: () => {},
    text: (d) => events.push(`text ${d}`),
    toolCall: (n) => events.push(`call ${n}`),
    toolResult: (n, r) => events.push(`result ${n} ${r}`),
    delivered: (t) => events.push(`delivered ${t}`),
    notice: (m) => events.push(`notice ${m}`),
    end: () => events.push("end"),
  };
  const turns = new Turns(chat, out, dir, "browser");
  await turns.send("what is the code?");
  assert.deepEqual(events, ["start", "text Looking.", "call zoom", "result zoom user: the code is 4242", "end"]);
  assert.deepEqual(
    chat.messages.slice(1).map((m) => `${m.kind}: ${m.text}`),
    ["user: what is the code?", "orb: Looking.", 'tool: zoom {"id":0,"n":1}', "echo: user: the code is 4242", "orb: It is 4242."],
  );
  await chat.idle();
  chat.close();
});

test("the backend: Claude Code unless an API key is set, or ORB_BACKEND says", () => {
  assert.equal(fromEnv({}).backend, "claude-code");
  assert.equal(fromEnv({ ANTHROPIC_API_KEY: "k" }).backend, "api");
  assert.equal(fromEnv({ ANTHROPIC_API_KEY: "k", ORB_BACKEND: "claude-code" }).backend, "claude-code");
  assert.throws(() => fromEnv({ ORB_BACKEND: "other" }), /bad ORB_BACKEND/);
});
