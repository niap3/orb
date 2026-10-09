// The tools. Their definitions never change (no dates, no state), and
// compactions send the very same list (never called) so they share the cache.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export const tools: BetaTool[] = [
  {
    name: "zoom",
    description:
      "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. n is a power of 2, and id a multiple of n.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", description: "The line's first message." },
        n: { type: "integer", description: "How many messages the line covers." },
      },
      required: ["id", "n"],
    },
  },
  {
    name: "date",
    description: "The date and time of message id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "shell",
    description:
      "Run a bash command on the user's computer, in the working directory, and get its exit code and output (stdout and stderr together).",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "integer", description: "Seconds before the command is killed. Default 120, at most 600." },
      },
      required: ["command"],
    },
    eager_input_streaming: true,
  },
  {
    name: "read",
    description: "Read a text file, with line numbers. Relative paths start at the working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", description: "First line to read, from 1." },
        limit: { type: "integer", description: "How many lines to read." },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Write a text file whole, creating it and its directories if needed.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    eager_input_streaming: true,
  },
  {
    name: "edit",
    description:
      "Replace old with new in a text file. old must match exactly and only once, unless all is true, which replaces every match.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
        all: { type: "boolean" },
      },
      required: ["path", "old", "new"],
    },
    eager_input_streaming: true,
  },
];

export interface Memory {
  zoom(id: number, n: number): string;
  date(id: number): string;
}

export class ToolError extends Error {}

type Input = Record<string, unknown>;

function want<T>(input: Input, field: string, type: "string" | "number" | "boolean", optional = false): T {
  const v = input[field];
  if (v === undefined && optional) return undefined as T;
  if (typeof v !== type || (type === "number" && !Number.isInteger(v))) {
    throw new ToolError(`${field} must be ${type === "number" ? "an integer" : `a ${type}`}`);
  }
  return v as T;
}

function resolve(cwd: string, p: string): string {
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(cwd, p);
}

function shell(command: string, cwd: string, timeoutS: number, signal?: AbortSignal): Promise<string> {
  return new Promise((done) => {
    const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], signal });
    const out: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => out.push(d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutS * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      done(`error: ${e.message}\n${Buffer.concat(out).toString("utf8")}`);
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      const status = timedOut ? `killed after ${timeoutS}s` : sig ? `killed by ${sig}` : `exit code ${code}`;
      done(`${status}\n${Buffer.concat(out).toString("utf8")}`);
    });
  });
}

/** Run one tool call. Throws ToolError for a bad call; its message goes back as an error result. */
export async function runTool(name: string, input: Input, memory: Memory, cwd: string, signal?: AbortSignal): Promise<string> {
  switch (name) {
    case "zoom":
      return memory.zoom(want<number>(input, "id", "number"), want<number>(input, "n", "number"));
    case "date":
      return memory.date(want<number>(input, "id", "number"));
    case "shell": {
      const t = want<number | undefined>(input, "timeout", "number", true) ?? 120;
      return shell(want<string>(input, "command", "string"), cwd, Math.min(Math.max(t, 1), 600), signal);
    }
    case "read": {
      const file = resolve(cwd, want<string>(input, "path", "string"));
      const offset = want<number | undefined>(input, "offset", "number", true) ?? 1;
      const limit = want<number | undefined>(input, "limit", "number", true);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const start = Math.max(offset, 1) - 1;
      const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
      const width = String(end).length;
      const body = lines.slice(start, end).map((l, k) => `${String(start + k + 1).padStart(width)}\t${l}`);
      return `${file}: lines ${start + 1}-${end} of ${lines.length}\n${body.join("\n")}`;
    }
    case "write": {
      const file = resolve(cwd, want<string>(input, "path", "string"));
      const content = want<string>(input, "content", "string");
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      return `wrote ${Buffer.byteLength(content)} bytes to ${file}`;
    }
    case "edit": {
      const file = resolve(cwd, want<string>(input, "path", "string"));
      const old = want<string>(input, "old", "string");
      const neu = want<string>(input, "new", "string");
      const all = want<boolean | undefined>(input, "all", "boolean", true) ?? false;
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      if (old === "") throw new ToolError("old must not be empty");
      const matches = text.split(old).length - 1;
      if (matches === 0) throw new ToolError(`old was not found in ${file}`);
      if (matches > 1 && !all) throw new ToolError(`old matches ${matches} times in ${file}: give more context, or set all`);
      fs.writeFileSync(file, all ? text.split(old).join(neu) : text.replace(old, () => neu));
      return `replaced ${all ? matches : 1} match${matches > 1 && all ? "es" : ""} in ${file}`;
    }
    default:
      throw new ToolError(`no tool named ${name}`);
  }
}
