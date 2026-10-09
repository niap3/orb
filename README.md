# orb

One chat that never ends. Orb is an AI agent whose memory is the chat
itself. This repo implements the design in
[niap3's UniiChat gist](https://gist.github.com/niap3/6936f44aef11bcbfcc80f52109f32fad),
which is a fork of VictorTaelin's `optchat.md`:

- Every message is logged word for word, forever, to append-only JSONL files.
- In the background, a cheap model (Claude Haiku 5.5) compresses the log
  into a binary tree of one-line summaries, each at most 512 bytes. Each
  message becomes a line, two adjacent lines merge into one, and so on.
- Each user message starts a fresh call. The model sees the **view**:
  summary lines covering the whole chat, fine for recent messages and
  coarse for old ones, 64–128 KB in all. Then it sees the new message.
- When a line is too vague, the model **zooms**: it opens the line into the
  two lines it was made from, down to the message itself.

The context stays a constant size, nothing is lost, and almost every input
token is read from the prompt cache.

## Use

You need Node 22.18 or later (it runs the TypeScript directly) and an
Anthropic API key.

```sh
npm install
export ANTHROPIC_API_KEY=...
node src/cli.ts            # or: npm link, then: orb
```

```
orb                  chat in the terminal
orb web [port]       chat in the browser (default port 4747)
orb note [file]      import notes (memories from before the chat), one per
                     paragraph, from a file or stdin
orb stats            sizes of the log, the tree and the views
orb view             print the view as the model sees it
```

### In the browser

```sh
orb web
```

This prints a link like `http://127.0.0.1:4747/#3f9c…`. Open it. The part
after `#` is a random access token, made fresh each time you start
`orb web`, so use the newly printed link after a restart. The page shows
the chat history and streams replies as they come, including thinking and
tool calls; click "output" under a tool call to see its result. Press Enter
to send, Shift+Enter for a new line, and Stop to interrupt a reply.

The server listens on your own machine only (127.0.0.1). Every request needs
the token, and requests with another host name are refused, so other
websites you visit can't drive Orb. Don't share the link.

### Choices, forms, charts and diagrams

When a click is quicker than typing, or a picture says more than a
paragraph, Orb shows blocks in the chat with its `ui` tool:

- **choices**: buttons for a question. Click one, or press its number when
  the message box is empty.
- **form**: fields to fill in (text, long text, number, date, a list to pick
  from, a checkbox).
- **table**, **chart** (bar or line) and **diagram** (boxes and arrows, laid
  out automatically).
- **svg**: a picture Orb draws. It's shown as an image, so nothing in it can
  run or load anything.

Your answer to choices or a form goes back as your next message, like
`Answer to "Which database?": Postgres`. In the terminal (`orb`), the blocks
show as plain text and you type the answer. Orb is told which interface
you're on.

### In the terminal

In the chat, type `/stats`, `/view`, `/zoom id n` or `/quit`. Ctrl-C stops a
running turn. A message you send while a turn is running reaches it between
tool calls.

The chat lives in `$ORB_DIR`, which defaults to `~/.orb`. Put your standing
instructions in `$ORB_DIR/instructions.md`: who you are, how your files are
organized, and how you want work done. They are appended to the system
prompt.

| Variable | Default | |
|---|---|---|
| `ORB_MODEL` | `claude-opus-5-5` | model for turns |
| `ORB_EFFORT` | `high` | effort for turns |
| `ORB_COMPACT_MODEL` | `claude-haiku-5-5` | model for compactions |
| `ORB_COMPACT_EFFORT` | `xhigh` | effort for compactions |
| `ORB_FALLBACKS` | on | set to `off` to disable server-side refusal fallbacks on turns |

**Billing.** Orb calls the Claude API, so it needs an API key from the
[Claude Console](https://platform.claude.com/), billed per token. A Claude
Pro or Max subscription can't be used: Anthropic allows subscription logins
only in Claude Code and its own apps, not in other programs (see
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
Summaries run on Haiku 5.5, which costs little, and most of each turn's
input is read from the prompt cache at a fraction of the normal price. To
spend less on replies, set `ORB_MODEL=claude-sonnet-5-5` or lower
`ORB_EFFORT`. A console spend limit is a good safety net.

**Orb's tools run with your permissions.** `shell`, `read`, `write` and
`edit` act on your computer in the directory you started Orb from, and they
have no sandbox and no confirmation prompts. Run it somewhere you trust it.

## Layout

```
src/tree.ts      node(l, i), names (id+n), parent, sibling, children
src/view.ts      the view, the due merge order, the sawtooth batches
src/store.ts     main/ and tree/ JSONL logs, view.json, the lock
src/chat.ts      the chat: logging, tree building, both views, the compactor
src/prompt.ts    the system prompt and the compaction task templates
src/model.ts     API calls, the cache-write gate, view cache blocks
src/tools.ts     zoom, date, shell, read, write, edit, ui
src/ui.ts        the ui tool's blocks: checks, and plain text for a terminal
src/turn.ts      the turn loop
src/cli.ts       the terminal interface
src/web.ts       orb web: the local server
src/web.html     orb web: the page
```

On disk:

```
$ORB_DIR/main/YYYY-MM-DD.jsonl   messages: {i, kind, text, size, date}
$ORB_DIR/tree/YYYY-MM-DD.jsonl   tree nodes: {l, i, text, size}
$ORB_DIR/view.json               the view, as [l, i] pairs
$ORB_DIR/cview.json              the compaction view
$ORB_DIR/instructions.md         your instructions (optional)
```

## How it follows the design

- **Merge order.** The view merges the pair with the highest
  `due = (T - last) / 2^l`, taking the oldest pair on ties, among pairs
  whose parent is built. A test runs Taelin's rollback `push` beside it for
  t = 0..20,000, using push's length as the budget, and the two match at
  every step.
- **Batching.** Each message appends one line. Once the view passes
  128,000 bytes, one batch merges it down to 64,000. If some parents
  aren't built yet, it merges what it can at each message until it reaches
  the target.
- **Persistence.** The view is saved after every change and loaded at
  start. It is never rebuilt, because a rebuilt view would invalidate the
  prompt cache.
- **Compactions** send the same system prompt and tools as turns, then
  their own view (the chat's view merged further, 16–32 KB), then the task
  with a 512-dash ruler. A line over 512 bytes gets the "Too long … ← LIMIT"
  follow-up, up to 5 tries, and the shortest line is kept. A source that
  fits in 512 bytes becomes its node with no call. Up to 8 calls run at
  once. Ready work waits in queues, and the tree is never scanned for work.
  A failed call is retried at the next message.
- **Caching.** The view goes in 4-line blocks, with a cache mark on the
  last whole block and one on the request's end. A call whose marked
  prefix another call is still writing waits until that call's response
  starts. The design doesn't mention one more mark, which I put on the
  system prompt, so the tools and system prompt stay cached after a batch.
- **Turns** wait until every earlier message is summarized, render the view,
  and only then log the new message. Each turn is a fresh call. The date
  and working directory go after the view, never in the system prompt.
  Thoughts are shown but never logged. Tool output is clipped to its head
  and tail, 30,000 characters in all. Other long text is split into
  several messages.

### Where it differs

- The agent is named Orb, so its replies have the kind `orb`.
- **No subagents and no remote computers.** The design lists both as
  optional, so I left them out, along with the system prompt's paragraphs
  about them. The tools run only on the machine Orb was started on.
- **Turns and compactions use different models**, Opus 5.5 and Haiku 5.5.
  The prompt cache is per model, so compactions share cache entries with
  each other but not with turns. To share one cache, set
  `ORB_COMPACT_MODEL` to the same model as `ORB_MODEL`, at a higher cost.
- **The turn wait has a limit.** If messages still aren't summarized after
  2 minutes (for example, because the API keeps failing), the turn goes
  ahead, and those lines show as `(not summarized yet: zoom it)`.
- Images are not supported, and `zoom(id, 1)` returns a message's text
  whole. Messages are split at 30,000 characters, so a zoom result never
  needs paging.

## Develop

```sh
npm test            # node:test, with a fake model
npm run typecheck   # tsc
```
