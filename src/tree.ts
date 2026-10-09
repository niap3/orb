// node(l, i) covers the 2^l messages from i·2^l on, and is named id+n:
// its first message and how many it covers. node(3, 5) is 40+8.

export type Node = readonly [l: number, i: number];

export function first([l, i]: Node): number {
  return i * 2 ** l;
}

export function count([l]: Node): number {
  return 2 ** l;
}

/** The node's last message. */
export function last(n: Node): number {
  return first(n) + count(n) - 1;
}

export function name(n: Node): string {
  return `${first(n)}+${count(n)}`;
}

export function key([l, i]: Node): string {
  return `${l}:${i}`;
}

export function parent([l, i]: Node): Node {
  return [l + 1, i >> 1];
}

export function sibling([l, i]: Node): Node {
  return [l, i ^ 1];
}

export function children([l, i]: Node): [Node, Node] {
  return [
    [l - 1, 2 * i],
    [l - 1, 2 * i + 1],
  ];
}

/** The node named id+n, or an error message. */
export function parseName(id: number, n: number): Node | string {
  if (!Number.isInteger(id) || id < 0) return `id must be a whole number >= 0, got ${id}`;
  if (!Number.isInteger(n) || n < 1 || (n & (n - 1)) !== 0) return `n must be a power of 2, got ${n}`;
  if (id % n !== 0) return `id must be a multiple of n: ${id} is not a multiple of ${n}`;
  const l = Math.log2(n);
  return [l, id / n];
}
