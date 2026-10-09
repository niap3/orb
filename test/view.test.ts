import assert from "node:assert/strict";
import { test } from "node:test";
import { type Node, first, count, key } from "../src/tree.ts";
import { View, type NodeTexts } from "../src/view.ts";

// Taelin's rollback push (rollback_state_list.js, 2022), as given in the design.
interface States {
  keep: number;
  life: number;
  state: number;
  older: States | null;
}
function push(newState: number, states: States | null): States {
  if (states === null) return { keep: 0, life: 0, state: newState, older: null };
  const { keep, life, state, older } = states;
  if (keep === 0) return { keep: 1, life, state, older };
  if (life > 0) {
    return { keep: 0, life: 0, state: newState, older: { keep: 0, life: life - 1, state, older } };
  }
  return { keep: 0, life, state: newState, older: push(state, older) };
}

/** Push's list read as view lines, oldest first: [first, count]. */
function pushLines(states: States | null, T: number): [number, number][] {
  const starts: number[] = [];
  for (let s = states; s; s = s.older) starts.push(s.state);
  starts.reverse();
  return starts.map((s, k) => [s, (k + 1 < starts.length ? starts[k + 1] : T) - s]);
}

const allBuilt: NodeTexts = { text: () => "x" };

/** A view where every line costs 1, so the budget is a line count. */
class CountView extends View {
  override lineBytes(): number {
    return 1;
  }
}

const lines = (v: View) => v.lines.map((n) => [first(n), count(n)]);

test("due order makes exactly push's merges, with push's length as budget", () => {
  let states: States | null = null;
  const view = new CountView(allBuilt);
  let mismatches = 0;
  for (let t = 0; t <= 20_000; t++) {
    states = push(t, states);
    view.append([0, t]);
    const want = pushLines(states, t + 1);
    view.shrink(want.length, t + 1);
    if (JSON.stringify(lines(view)) !== JSON.stringify(want)) mismatches++;
  }
  assert.equal(mismatches, 0);
});

test("the design's example: at T=10 merge 8-9, not 0-7", () => {
  const view = new CountView(allBuilt, [
    [2, 0],
    [2, 1],
    [0, 8],
    [0, 9],
  ]);
  view.shrink(3, 10);
  assert.deepEqual(lines(view), [
    [0, 4],
    [4, 4],
    [8, 2],
  ]);
});

test("a bigger budget keeps detail fading with age", () => {
  const view = new CountView(allBuilt);
  for (let t = 0; t < 100_000; t++) {
    view.append([0, t]);
    if (view.lines.length > 200) view.shrink(100, t + 1);
  }
  // Every line is a tree node, the lines cover the chat in order, and
  // levels never grow toward the present.
  let at = 0;
  for (const n of view.lines) {
    assert.equal(first(n), at);
    at += count(n);
  }
  assert.equal(at, 100_000);
  for (let k = 1; k < view.lines.length; k++) assert.ok(view.lines[k][0] <= view.lines[k - 1][0]);
  const levels = new Set(view.lines.map((n) => n[0]));
  assert.ok(levels.size >= 10, `levels: ${[...levels]}`);
});

test("only pairs with a built parent merge", () => {
  const built = new Set(["0:0", "0:1", "0:2", "0:3", "1:1"]);
  const tree: NodeTexts = { text: (n: Node) => (built.has(key(n)) ? "x" : undefined) };
  const view = new CountView(tree, [
    [0, 0],
    [0, 1],
    [0, 2],
    [0, 3],
  ]);
  view.shrink(1, 4);
  // 0+2 is unbuilt, so 0-1 stays; 2-3 merges; 0+4 needs 0+2.
  assert.deepEqual(lines(view), [
    [0, 1],
    [1, 1],
    [2, 2],
  ]);
});

test("prefix stops at the end and at the first unbuilt line", () => {
  const built = new Set(["1:0", "0:2", "0:4"]);
  const tree: NodeTexts = { text: (n: Node) => (built.has(key(n)) ? "x" : undefined) };
  const view = new View(tree, [
    [1, 0],
    [0, 2],
    [0, 3],
    [0, 4],
  ]);
  assert.deepEqual(view.prefix(10), [
    [1, 0],
    [0, 2],
  ]);
  assert.deepEqual(view.prefix(1), [[1, 0]]);
  assert.match(view.render()[2], /^3\+1\|\(not summarized yet: zoom it\)$/);
});
