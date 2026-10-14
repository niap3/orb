// The ui tool: blocks the agent shows in the chat when they say it faster or
// clearer than text. Choices and forms send the user's answer back as their
// next message. The browser draws every block; a terminal gets plain text.

import { ToolError } from "./errors.ts";

export type Field = {
  name: string;
  label?: string;
  input?: "text" | "long" | "number" | "date" | "select" | "checkbox";
  options?: string[];
  value?: string | number | boolean;
  placeholder?: string;
};

export type Block =
  | { type: "choices"; question: string; options: string[]; multiple?: boolean }
  | { type: "form"; title: string; fields: Field[]; submit?: string }
  | { type: "table"; title?: string; columns: string[]; rows: (string | number)[][] }
  | { type: "chart"; kind: "bar" | "line"; title?: string; labels: string[]; series: { name: string; values: number[] }[] }
  | {
      type: "diagram";
      title?: string;
      direction?: "down" | "right";
      nodes: { id: string; label?: string }[];
      edges: { from: string; to: string; label?: string }[];
    }
  | { type: "svg"; title?: string; svg: string };

export const uiToolDescription = `Show blocks in the chat when they are faster or clearer than text:
- choices: buttons for a question with a few answers. {type: "choices", question, options: [string], multiple?: boolean}
- form: fields to fill in. {type: "form", title, fields: [{name, label?, input?: "text"|"long"|"number"|"date"|"select"|"checkbox", options?: [string] (for select), value?, placeholder?}], submit?: button label}
- table: {type: "table", title?, columns: [string], rows: [[string|number]]}
- chart: {type: "chart", kind: "bar"|"line", title?, labels: [string], series: [{name, values: [number]}]} (one value per label)
- diagram: boxes and arrows, laid out for you. {type: "diagram", title?, direction?: "down"|"right", nodes: [{id, label?}], edges: [{from, to, label?}]}
- svg: a picture or illustration you draw. {type: "svg", title?, svg: "<svg viewBox=...>...</svg>"} (no scripts or external images; shown as an image on a dark gray #33363a background, so draw with light colors or give it its own background)
The user's answer to choices or a form comes back as their next message, so end your turn after asking.`;

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${what} must be a non-empty string`);
  return v;
}

function strs(v: unknown, what: string, min = 1): string[] {
  if (!Array.isArray(v) || v.length < min || !v.every((x) => typeof x === "string")) {
    throw new ToolError(`${what} must be a list of at least ${min} strings`);
  }
  return v as string[];
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ToolError(`${what} must be an object`);
  return v as Record<string, unknown>;
}

const INPUTS = ["text", "long", "number", "date", "select", "checkbox"];

/** The blocks of a ui call, checked; a ToolError says what to fix. */
export function checkUi(input: Record<string, unknown>): Block[] {
  const blocks = input.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) throw new ToolError("blocks must be a non-empty list");
  return blocks.map((raw, k) => {
    const b = obj(raw, `blocks[${k}]`);
    const at = `blocks[${k}] (${String(b.type)})`;
    switch (b.type) {
      case "choices":
        str(b.question, `${at}.question`);
        strs(b.options, `${at}.options`, 2);
        break;
      case "form": {
        str(b.title, `${at}.title`);
        if (!Array.isArray(b.fields) || b.fields.length === 0) throw new ToolError(`${at}.fields must be a non-empty list`);
        for (const [j, f] of b.fields.entries()) {
          const field = obj(f, `${at}.fields[${j}]`);
          str(field.name, `${at}.fields[${j}].name`);
          if (field.input !== undefined && !INPUTS.includes(field.input as string)) {
            throw new ToolError(`${at}.fields[${j}].input must be one of ${INPUTS.join(", ")}`);
          }
          if (field.input === "select") strs(field.options, `${at}.fields[${j}].options`);
        }
        break;
      }
      case "table": {
        const cols = strs(b.columns, `${at}.columns`);
        if (!Array.isArray(b.rows)) throw new ToolError(`${at}.rows must be a list of rows`);
        for (const [j, r] of b.rows.entries()) {
          if (!Array.isArray(r) || r.length !== cols.length) throw new ToolError(`${at}.rows[${j}] must have ${cols.length} cells`);
        }
        break;
      }
      case "chart": {
        if (b.kind !== "bar" && b.kind !== "line") throw new ToolError(`${at}.kind must be "bar" or "line"`);
        const labels = strs(b.labels, `${at}.labels`);
        if (!Array.isArray(b.series) || b.series.length === 0) throw new ToolError(`${at}.series must be a non-empty list`);
        for (const [j, s] of b.series.entries()) {
          const series = obj(s, `${at}.series[${j}]`);
          str(series.name, `${at}.series[${j}].name`);
          const v = series.values;
          if (!Array.isArray(v) || v.length !== labels.length || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
            throw new ToolError(`${at}.series[${j}].values must be ${labels.length} numbers, one per label`);
          }
        }
        break;
      }
      case "diagram": {
        if (!Array.isArray(b.nodes) || b.nodes.length === 0) throw new ToolError(`${at}.nodes must be a non-empty list`);
        const ids = new Set<string>();
        for (const [j, n] of b.nodes.entries()) ids.add(str(obj(n, `${at}.nodes[${j}]`).id, `${at}.nodes[${j}].id`));
        if (!Array.isArray(b.edges)) throw new ToolError(`${at}.edges must be a list`);
        for (const [j, e] of b.edges.entries()) {
          const edge = obj(e, `${at}.edges[${j}]`);
          for (const end of ["from", "to"]) {
            if (!ids.has(edge[end] as string)) throw new ToolError(`${at}.edges[${j}].${end} must be a node id`);
          }
        }
        break;
      }
      case "svg": {
        const svg = str(b.svg, `${at}.svg`);
        if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg)) throw new ToolError(`${at}.svg must start with <svg`);
        break;
      }
      default:
        throw new ToolError(`${at}: type must be one of choices, form, table, chart, diagram, svg`);
    }
    return b as Block;
  });
}

/** The blocks as plain text, for a terminal. */
export function uiText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "choices":
        out.push(`? ${b.question}${b.multiple ? " (pick any)" : ""}`);
        b.options.forEach((o, k) => out.push(`  ${k + 1}. ${o}`));
        break;
      case "form":
        out.push(`▤ ${b.title}`);
        for (const f of b.fields) {
          const opts = f.options ? ` (${f.options.join(" / ")})` : "";
          out.push(`  ${f.label ?? f.name}${opts}${f.value !== undefined ? `: ${f.value}` : ""}`);
        }
        break;
      case "table": {
        if (b.title) out.push(b.title);
        const rows = [b.columns, ...b.rows.map((r) => r.map(String))];
        const w = b.columns.map((_, c) => Math.max(...rows.map((r) => String(r[c]).length)));
        rows.forEach((r, k) => {
          out.push("  " + r.map((cell, c) => String(cell).padEnd(w[c])).join("  "));
          if (k === 0) out.push("  " + w.map((n) => "─".repeat(n)).join("  "));
        });
        break;
      }
      case "chart":
        out.push(`▥ ${b.title ?? `${b.kind} chart`}`);
        for (const s of b.series) out.push(`  ${s.name}: ${b.labels.map((l, k) => `${l} ${s.values[k]}`).join(", ")}`);
        break;
      case "diagram": {
        out.push(`◇ ${b.title ?? "diagram"}`);
        const label = new Map(b.nodes.map((n) => [n.id, n.label ?? n.id]));
        for (const e of b.edges) out.push(`  ${label.get(e.from)} → ${label.get(e.to)}${e.label ? ` (${e.label})` : ""}`);
        if (b.edges.length === 0) for (const n of b.nodes) out.push(`  ${n.label ?? n.id}`);
        break;
      }
      case "svg":
        out.push(`▣ picture${b.title ? `: ${b.title}` : ""} (open orb web to see it)`);
        break;
    }
  }
  return out.join("\n");
}
