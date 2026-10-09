import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Chat } from "../src/chat.ts";
import { defaults } from "../src/config.ts";
import type { ModelClient, StreamHandlers } from "../src/model.ts";
import { serve } from "../src/web.ts";

class Fake implements ModelClient {
  async stream(p: BetaMessageStreamParams, h: StreamHandlers): Promise<BetaMessage> {
    h.onStart?.();
    const text = p.model === defaults.compactModel ? "a summary" : "hello back";
    if (p.model !== defaults.compactModel) h.onText?.(text);
    return {
      id: "m",
      type: "message",
      role: "assistant",
      model: "fake",
      content: [{ type: "text", text, citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as BetaMessage;
  }
}

function request(
  port: number,
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => done({ status: res.statusCode!, body: data }));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("orb web: the token guards the API; a message streams back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-web-"));
  const chat = new Chat({ dir, cfg: defaults, client: new Fake() });
  chat.log("note", "the user likes tea");
  const server = await serve({ chat, port: 0, token: "secret", cwd: dir });
  const { port } = server;
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#secret$/);
  const auth = { "x-orb-token": "secret" };

  // The page itself needs no token; the API does.
  const page = await request(port, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.body, /<title>Orb<\/title>/);
  assert.equal((await request(port, "GET", "/api/history")).status, 401);
  assert.equal((await request(port, "GET", "/api/history", { "x-orb-token": "wrong" })).status, 401);
  // DNS rebinding: a foreign Host is refused even with the token.
  assert.equal((await request(port, "GET", "/api/history", { ...auth, host: "evil.example" })).status, 403);

  const hist = JSON.parse((await request(port, "GET", "/api/history", auth)).body);
  assert.deepEqual(
    hist.messages.map((m: { kind: string; text: string }) => [m.kind, m.text]),
    [["note", "the user likes tea"]],
  );

  // Listen to the event stream, then send a message.
  const events: { type: string; [k: string]: unknown }[] = [];
  const ended = new Promise<void>((done) => {
    http.get({ host: "127.0.0.1", port, path: "/api/events?t=secret" }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        for (let k = buf.indexOf("\n\n"); k >= 0; k = buf.indexOf("\n\n")) {
          const chunk = buf.slice(0, k);
          buf = buf.slice(k + 2);
          if (!chunk.startsWith("data: ")) continue;
          const e = JSON.parse(chunk.slice(6));
          events.push(e);
          if (e.type === "hello") void request(port, "POST", "/api/send", auth, { text: "hi" });
          if (e.type === "end") {
            res.destroy();
            done();
          }
        }
      });
    });
  });
  await ended;
  assert.deepEqual(
    events.map((e) => e.type),
    ["hello", "user", "start", "text", "end"],
  );
  assert.equal(events[3].d, "hello back");
  assert.equal((await request(port, "POST", "/api/send", auth, { text: "  " })).status, 400);

  const after = JSON.parse((await request(port, "GET", "/api/history", auth)).body);
  assert.deepEqual(
    after.messages.map((m: { kind: string }) => m.kind),
    ["note", "user", "orb"],
  );
  const state = JSON.parse((await request(port, "GET", "/api/state", auth)).body);
  assert.equal(state.busy, false);
  assert.equal(state.messages, 3);

  await server.close();
  chat.close();
});
