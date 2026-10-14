// A minimal MCP server over streamable HTTP (JSON responses, no server
// stream), so Claude Code can call Orb's own tools: zoom, date and ui. It
// listens on localhost under a random path, and lives in Orb's process,
// which owns the chat.

import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export type McpCall = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

export interface McpServer {
  /** The entry for Claude Code's --mcp-config. */
  config: { type: "http"; url: string };
  close(): Promise<void>;
}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export function startMcp(tools: BetaTool[], call: McpCall): Promise<McpServer> {
  const path = `/mcp/${randomBytes(16).toString("hex")}`;
  const list = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));

  async function handle(msg: Rpc): Promise<object | null> {
    const reply = (result: object) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined) return null; // a notification
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "orb", version: "0.1.0" },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: list });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        if (!list.some((t) => t.name === name)) return fail(-32602, `no tool named ${name}`);
        const { text, isError } = await call(name, (msg.params?.arguments ?? {}) as Record<string, unknown>);
        return reply({ content: [{ type: "text", text }], isError });
      }
      default:
        return fail(-32601, `method not found: ${msg.method}`);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end(); // no server-initiated stream
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: Rpc | Rpc[];
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }
      const msgs = Array.isArray(body) ? body : [body];
      const out = (await Promise.all(msgs.map(handle))).filter((r) => r !== null);
      if (out.length === 0) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(Array.isArray(body) ? out : out[0]));
    });
  });

  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      done({
        config: { type: "http", url: `http://127.0.0.1:${port}${path}` },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
