// A stand-in for `claude -p` in stream-json mode, for tests: it answers each
// message on stdin with a scripted run, and exits when stdin closes.
import readline from "node:readline";

const args = process.argv.slice(2);
const compaction = args[args.indexOf("--tools") + 1] === "";
const emit = (e) => process.stdout.write(JSON.stringify(e) + "\n");
let n = 0;

emit({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  emit({ type: "user", message: msg.message, parent_tool_use_id: null, isReplay: true });
  n++;
  const text = JSON.stringify(msg.message.content);
  if (compaction) {
    // Too long the first time, to exercise the retry.
    emit({ type: "result", subtype: "success", is_error: false, result: text.includes("Too long") ? "short line" : "y".repeat(600) });
    continue;
  }
  if (n === 1) {
    emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } } });
    emit({ type: "assistant", parent_tool_use_id: null, message: { content: [
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "mcp__orb__zoom", input: { id: 0, n: 1 } },
    ] } });
    emit({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "user: the code is 4242" }] }] } });
    emit({ type: "assistant", parent_tool_use_id: "sub1", message: { content: [{ type: "text", text: "a subagent's inner step" }] } });
    emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "It is 4242." }] } });
  } else {
    emit({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Also answered." }] } });
  }
  emit({ type: "result", subtype: "success", is_error: false, result: "ok" });
}
