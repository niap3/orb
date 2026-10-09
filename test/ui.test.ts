import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolError } from "../src/errors.ts";
import { runTool, tools } from "../src/tools.ts";
import { checkUi, uiText } from "../src/ui.ts";

const memory = { zoom: () => "", date: () => "" };

test("ui: good blocks pass, and say how the answer comes back", async () => {
  const blocks = [
    { type: "choices", question: "Which database?", options: ["Postgres", "SQLite"] },
    { type: "form", title: "Trip", fields: [{ name: "city" }, { name: "nights", input: "number" }, { name: "class", input: "select", options: ["eco", "biz"] }] },
    { type: "table", columns: ["a", "b"], rows: [["x", 1]] },
    { type: "chart", kind: "bar", labels: ["q1", "q2"], series: [{ name: "rev", values: [1, 2] }] },
    { type: "diagram", nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }] },
    { type: "svg", svg: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' },
  ];
  assert.equal(checkUi({ blocks }).length, 6);
  assert.match(await runTool("ui", { blocks }, memory, "/"), /their next message/);
  assert.ok(tools.some((t) => t.name === "ui"));
});

test("ui: a bad block says what to fix", () => {
  const bad: [unknown, RegExp][] = [
    [[], /non-empty list/],
    [[{ type: "choices", question: "q", options: ["one"] }], /options must be a list of at least 2/],
    [[{ type: "table", columns: ["a", "b"], rows: [["x"]] }], /rows\[0\] must have 2 cells/],
    [[{ type: "chart", kind: "pie", labels: ["a"], series: [] }], /kind must be "bar" or "line"/],
    [[{ type: "chart", kind: "bar", labels: ["a", "b"], series: [{ name: "s", values: [1] }] }], /2 numbers, one per label/],
    [[{ type: "diagram", nodes: [{ id: "a" }], edges: [{ from: "a", to: "z" }] }], /to must be a node id/],
    [[{ type: "svg", svg: "<script>alert(1)</script>" }], /must start with <svg/],
    [[{ type: "form", title: "t", fields: [{ name: "x", input: "color" }] }], /input must be one of/],
    [[{ type: "video" }], /type must be one of/],
  ];
  for (const [blocks, why] of bad) assert.throws(() => checkUi({ blocks }), (e: Error) => e instanceof ToolError && why.test(e.message));
});

test("ui: a terminal gets plain text", () => {
  const text = uiText(
    checkUi({
      blocks: [
        { type: "choices", question: "Which?", options: ["A", "B"] },
        { type: "table", columns: ["name", "n"], rows: [["x", 10], ["yy", 2]] },
        { type: "diagram", nodes: [{ id: "a", label: "Start" }, { id: "b", label: "End" }], edges: [{ from: "a", to: "b", label: "go" }] },
        { type: "svg", title: "logo", svg: "<svg></svg>" },
      ],
    }),
  );
  assert.equal(
    text,
    [
      "? Which?",
      "  1. A",
      "  2. B",
      "  name  n ",
      "  ────  ──",
      "  x     10",
      "  yy    2 ",
      "◇ diagram",
      "  Start → End (go)",
      "▣ picture: logo (open orb web to see it)",
    ].join("\n"),
  );
});
