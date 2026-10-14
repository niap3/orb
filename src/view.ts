// The view: a list of tree nodes that covers the whole chat, oldest first.
//
// Which lines merge comes from Taelin's rollback push. For sibling lines
// (l, i) and (l, i+1), with T messages in the chat:
//
//   due = (T - last) / 2^l        last: the pair's last message
//
// To shrink, merge the most due pair whose parent is built, the oldest of
// equal pairs, and repeat. When: each message appends its line, and once the
// view passes its max, one batch merges down to its min.

import { bytes, flat } from "./text.ts";
import { type Node, count, first, last, name, parent } from "./tree.ts";

export const PLACEHOLDER = "(not summarized yet: zoom it)";

export interface NodeTexts {
  /** The node's text, or undefined while it is unbuilt. */
  text(n: Node): string | undefined;
}

export function renderLine(n: Node, text: string | undefined): string {
  return `${name(n)}|${flat(text ?? PLACEHOLDER)}`;
}

export class View {
  lines: Node[];
  /** A batch that could not reach its target yet: keep merging at each message. */
  shrinking = false;
  private readonly tree: NodeTexts;

  constructor(tree: NodeTexts, lines: Node[] = []) {
    this.tree = tree;
    this.lines = lines;
  }

  /** The message count the view covers. */
  end(): number {
    const n = this.lines.at(-1);
    return n ? last(n) + 1 : 0;
  }

  lineBytes(n: Node): number {
    return bytes(renderLine(n, this.tree.text(n))) + 1; // + newline
  }

  size(): number {
    let s = 0;
    for (const n of this.lines) s += this.lineBytes(n);
    return s;
  }

  append(n: Node): void {
    if (first(n) !== this.end()) throw new Error(`view: ${name(n)} does not follow ${this.end()}`);
    this.lines.push(n);
  }

  /**
   * Merge the most due built pairs until the view is at most target bytes.
   * T is the number of messages in the chat. Returns the merges made.
   */
  shrink(target: number, T: number): number {
    let size = this.size();
    let merges = 0;
    while (size > target) {
      let best = -1;
      let bestDue = -Infinity;
      for (let k = 0; k + 1 < this.lines.length; k++) {
        const a = this.lines[k];
        const b = this.lines[k + 1];
        if (a[0] !== b[0] || a[1] % 2 !== 0 || b[1] !== a[1] + 1) continue;
        if (this.tree.text(parent(a)) === undefined) continue;
        const due = (T - last(b)) / count(a);
        // Strictly greater, scanning oldest first: ties go to the oldest pair.
        if (due > bestDue) {
          bestDue = due;
          best = k;
        }
      }
      if (best < 0) break;
      const [a, b] = [this.lines[best], this.lines[best + 1]];
      const p = parent(a);
      size += this.lineBytes(p) - this.lineBytes(a) - this.lineBytes(b);
      this.lines.splice(best, 2, p);
      merges++;
    }
    return merges;
  }

  /** The lines up to message end (inclusive), stopping at the first unbuilt one. */
  prefix(end: number): Node[] {
    const out: Node[] = [];
    for (const n of this.lines) {
      if (last(n) > end || this.tree.text(n) === undefined) break;
      out.push(n);
    }
    return out;
  }

  render(lines: readonly Node[] = this.lines): string[] {
    return lines.map((n) => renderLine(n, this.tree.text(n)));
  }
}
