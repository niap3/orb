// The log, on disk:
//
//   main/YYYY-MM-DD.jsonl   messages, one per line: {i, kind, text, size, date}
//   tree/YYYY-MM-DD.jsonl   tree nodes, one per line: {l, i, text, size}
//   view.json               the view, as [l, i] pairs
//   cview.json              the compaction view, the same way
//
// Only append, and flush each write. Never edit or delete a line. One
// process owns a chat: it holds `lock`.

import fs from "node:fs";
import path from "node:path";
import type { Node } from "./tree.ts";

export type Kind = string; // "user" | agent name | "tool" | "echo" | "work" | "note"

export interface Message {
  i: number;
  kind: Kind;
  text: string;
  size: number;
  date: string;
}

export interface NodeRecord {
  l: number;
  i: number;
  text: string;
  size: number;
}

function day(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Each complete JSON line of each file in dir, files in name order. */
function readLines<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  const out: T[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as T);
      } catch {
        // A line cut off by a crash: it was never acknowledged, so drop it.
      }
    }
  }
  return out;
}

class DailyLog {
  private fd: number | null = null;
  private openDay = "";
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  append(record: object, date: Date): void {
    const d = day(date);
    if (this.fd === null || d !== this.openDay) {
      if (this.fd !== null) fs.closeSync(this.fd);
      const file = path.join(this.dir, `${d}.jsonl`);
      this.fd = fs.openSync(file, "a");
      this.openDay = d;
      // A crash can leave a cut line with no newline: start on a fresh line.
      const size = fs.fstatSync(this.fd).size;
      if (size > 0) {
        const last = Buffer.alloc(1);
        const rfd = fs.openSync(file, "r");
        fs.readSync(rfd, last, 0, 1, size - 1);
        fs.closeSync(rfd);
        if (last[0] !== 0x0a) fs.writeSync(this.fd, "\n");
      }
    }
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
    fs.fdatasyncSync(this.fd);
  }
  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, data);
  fs.fdatasyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Store {
  readonly dir: string;
  private readonly main: DailyLog;
  private readonly tree: DailyLog;
  private readonly lockFile: string;
  private locked = false;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.lockFile = path.join(dir, "lock");
    this.lock();
    this.main = new DailyLog(path.join(dir, "main"));
    this.tree = new DailyLog(path.join(dir, "tree"));
  }

  private lock(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockFile, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        this.locked = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = Number(fs.readFileSync(this.lockFile, "utf8").trim());
        if (pid && pid !== process.pid && alive(pid)) {
          throw new Error(`${this.dir} is open in another process (pid ${pid})`);
        }
        fs.rmSync(this.lockFile, { force: true }); // stale lock
      }
    }
    throw new Error(`could not lock ${this.dir}`);
  }

  loadMessages(): Message[] {
    const all = readLines<Message>(path.join(this.dir, "main"));
    // Ids are dense from 0. Anything after a gap was never acknowledged.
    const out: Message[] = [];
    for (const m of all.sort((a, b) => a.i - b.i)) {
      if (m.i === out.length) out.push(m);
    }
    return out;
  }

  loadNodes(): NodeRecord[] {
    return readLines<NodeRecord>(path.join(this.dir, "tree"));
  }

  loadView(file: "view.json" | "cview.json"): Node[] | null {
    const p = path.join(this.dir, file);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as Node[];
    } catch {
      return null;
    }
  }

  appendMessage(m: Message): void {
    this.main.append(m, new Date(m.date));
  }

  appendNode(n: NodeRecord): void {
    this.tree.append(n, new Date());
  }

  saveView(file: "view.json" | "cview.json", view: readonly Node[]): void {
    writeAtomic(path.join(this.dir, file), JSON.stringify(view));
  }

  readInstructions(): string {
    const p = path.join(this.dir, "instructions.md");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  }

  close(): void {
    this.main.close();
    this.tree.close();
    if (this.locked) fs.rmSync(this.lockFile, { force: true });
    this.locked = false;
  }
}
