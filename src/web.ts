// orb web: the chat in a browser. One page, served on localhost only.
//
// The agent runs shell commands, so no other web page may drive it: every
// API call needs a random token (printed in the URL at start), sent in a
// custom header, which cross-site pages can't send without a CORS preflight
// that this server never answers. The Host header is checked too, against
// DNS rebinding.

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Chat } from "./chat.ts";
import { clip } from "./text.ts";
import { type Output, Turns } from "./turn.ts";

const PAGE = fs.readFileSync(new URL("./web.html", import.meta.url), "utf8");

/** Tool calls and results can be 30,000 characters; the page shows less. */
const SHOW = 4_000;

export interface WebOptions {
  chat: Chat;
  port?: number;
  host?: string;
  token?: string;
  cwd?: string;
}

export interface WebServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

type Event = Record<string, unknown> & { type: string };

class Broadcast implements Output {
  readonly clients = new Set<http.ServerResponse>();
  busy = false;
  send(e: Event): void {
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of this.clients) res.write(data);
  }
  start(): void {
    this.busy = true;
    this.send({ type: "start" });
  }
  thinking(d: string): void {
    this.send({ type: "thinking", d });
  }
  text(d: string): void {
    this.send({ type: "text", d });
  }
  toolCall(name: string, input: unknown): void {
    // ui blocks go whole: the page draws them.
    const json = JSON.stringify(input);
    this.send({ type: "tool", name, input: name === "ui" ? json : clip(json, SHOW) });
  }
  toolResult(name: string, result: string, isError: boolean): void {
    this.send({ type: "result", name, result: clip(result, SHOW), isError });
  }
  delivered(text: string): void {
    this.send({ type: "delivered", text });
  }
  notice(message: string): void {
    this.send({ type: "notice", message });
  }
  end(): void {
    this.busy = false;
    this.send({ type: "end" });
  }
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, max = 1_000_000): Promise<string> {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        fail(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

export function serve(opts: WebOptions): Promise<WebServer> {
  const { chat } = opts;
  const host = opts.host ?? "127.0.0.1";
  const token = opts.token ?? randomBytes(16).toString("hex");
  const out = new Broadcast();
  const turns = new Turns(chat, out, opts.cwd, "browser");
  const agent = chat.cfg.name.toLowerCase();
  let port = 0;

  const state = () => {
    const s = chat.stats();
    return { name: chat.cfg.name, agent, busy: out.busy, messages: s.messages, viewBytes: s.viewBytes, dir: chat.store.dir };
  };

  const history = (before: number, limit: number) => {
    const end = Math.min(Math.max(before, 0), chat.messages.length);
    const start = Math.max(0, end - limit);
    return chat.messages.slice(start, end).map((m) => ({
      i: m.i,
      kind: m.kind,
      date: m.date,
      text: (m.kind === "tool" && !m.text.startsWith("ui ")) || m.kind === "echo" ? clip(m.text, SHOW) : m.text,
    }));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host ?? "";
      if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}` && hostHeader !== `[::1]:${port}`) {
        return json(res, 403, { error: "bad host" });
      }
      const url = new URL(req.url ?? "/", `http://${hostHeader}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:",
          "referrer-policy": "no-referrer",
        });
        return res.end(PAGE);
      }

      // Everything else is the API, and needs the token. EventSource can't
      // set headers, so the event stream alone takes it in the query.
      const given = url.pathname === "/api/events" ? (url.searchParams.get("t") ?? "") : String(req.headers["x-orb-token"] ?? "");
      if (!same(given, token)) return json(res, 401, { error: "bad token" });

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "hello", ...state() })}\n\n`);
        out.clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          out.clients.delete(res);
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, state());
      if (req.method === "GET" && url.pathname === "/api/history") {
        const before = Number(url.searchParams.get("before") ?? chat.messages.length);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
        return json(res, 200, { messages: history(before, limit) });
      }
      if (req.method === "POST" && url.pathname === "/api/send") {
        const { text } = JSON.parse(await readBody(req)) as { text?: unknown };
        if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "text must be a non-empty string" });
        out.send({ type: "user", text });
        void turns.send(text);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/stop") {
        turns.interrupt();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 4747, host, () => {
      port = (server.address() as AddressInfo).port;
      done({
        url: `http://${host === "::1" ? "[::1]" : host}:${port}/#${token}`,
        port,
        close: async () => {
          turns.interrupt();
          await turns.done();
          for (const res of out.clients) res.end();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
