# dsh-mcp-adapter

**Context-cheap, crash-resistant MCP access for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one lazy proxy tool instead of dumping every server's schema into context. Zero dependencies.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-green?style=for-the-badge)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-108%20passing-brightgreen?style=for-the-badge)](#testing)

The stock DSH rule is *one plugin = one MCP server*, and every one of that
server's tools is registered directly — so its full JSON schema sits in your
prompt on **every turn**, whether you use it or not. Connect a few servers with
dozens of tools each and you can burn 20k+ tokens before the conversation
starts.

This plugin replaces that with a single **`mcp`** proxy tool (~200 tokens). The
model searches for tools on demand, servers connect only when actually used, and
the tools you use constantly can be promoted back to first-class tools so they
keep zero-latency calls. It is written to a single overriding requirement: **it
must never crash DSH**, no matter how an MCP server misbehaves.

Inspired by [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) and
the broader "you might not need MCP" discussion; rebuilt for DSH's tool registry
with no runtime dependencies and a reliability-first core.

---

## The problem, in numbers

Three servers — Burp (10 tools), Chrome DevTools (15), a detection platform (70+):

| | Stock DSH (all direct) | With this adapter (hybrid) |
|---|---:|---:|
| Prompt tokens per turn | **~21,000** | **~3,200** |
| Server processes at boot | all 3 running | **0 until first use** |
| A down server | errors / retries in-band | fails fast, DSH unaffected |
| A 3 MB tool result | floods the context | truncated + spilled to a file |

The 70-tool server is the killer: loaded directly it costs ~16k tokens on every
message even while you are only doing web testing. Behind the proxy it costs
~200 tokens and its process does not even start until you call it.

---

## Install

```bash
git clone https://github.com/sehoon123/dsh-mcp-adapter.git
mkdir -p ~/.dsh/profiles/node_modules/@deepseek-ai
cp -R dsh-mcp-adapter ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-mcp-adapter
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: mcp-adapter
      name: '@deepseek-ai/dsh-mcp-adapter'
```

Point it at your servers with a standard `mcp.json` (the same file Claude
Desktop, Cursor, and pi use — see [Configuration](#configuration)), then restart
`dsh`. No API keys, no daemon, no Docker.

---

## Do I need to disable DSH's default MCP?

**No — there is nothing global to disable.** DSH ships with **no MCP server
enabled by default**; each server is an explicit `@deepseek-ai/dsh-mcp-client`
row you added yourself. So there is no "default MCP" toggle to turn off.

**This adapter and the stock `dsh-mcp-client` do not collide.** They register
tools in different name-spaces, so having both mounted breaks nothing:

| | Tool names it registers |
|---|---|
| stock `dsh-mcp-client` | `mcp__<server>__<tool>` (double underscore) |
| this adapter | `mcp` (proxy) and `mcp_<server>_<tool>` (single underscore, for `directTools`) |

The one thing you should **not** do is route the **same server through both** —
that gives you the full schema dump *and* the proxy for that server, wasting the
context you were trying to save. Pick one path per server. Two clean setups:

**A — everything through the adapter (recommended; lowest context).** Delete your
`dsh-mcp-client` rows and list every server in `mcp.json`. Promote the servers
you use constantly with `directTools` so they keep zero-latency calls:

```yaml
# cordis.patch.yml — remove any `- id: mcp-<server>` (dsh-mcp-client) rows, keep only:
- insert:
    - id: mcp-adapter
      name: '@deepseek-ai/dsh-mcp-adapter'
```
```jsonc
// ~/.dsh/mcp.json
{
  "mcpServers": {
    "burp-suite": { "type": "http", "url": "http://localhost:9876/mcp",
      "headers": { "Authorization": "Bearer <token>" }, "directTools": true },
    "chrome":     { "command": "npx", "args": ["-y", "chrome-devtools-mcp"],
      "directTools": ["take_screenshot", "click", "navigate"] },
    "falcon":     { "command": "npx", "args": ["-y", "@crowdstrike/falcon-mcp"] }
  }
}
```

**B — keep a couple of servers stock, adapter for the rest.** Also fine, because
the name-spaces do not clash. For example keep Burp as a direct `dsh-mcp-client`
row and put only the big/occasional servers (Falcon, etc.) behind the adapter.
Just don't list the same server in both places.

> TL;DR: nothing to disable; both can coexist; just don't double-route one server.

---

## How the model uses it

The model sees one tool, `mcp`, with four actions:

```jsonc
mcp({ action: "list" })                                  // what servers exist
mcp({ action: "search", query: "screenshot" })            // find tools by keyword
mcp({ action: "describe", server: "chrome", tool: "take_screenshot" })  // see its params
mcp({ action: "call", server: "chrome", tool: "take_screenshot", args: { … } })  // run it
```

`search` and `describe` are answered from an **offline metadata cache**, so the
model can explore the whole toolset without connecting to anything. Only `call`
(and a `describe` for a not-yet-cached server) actually connects.

On a fresh install that cache is empty, so the FIRST search transparently warms
any server it has never catalogued (time-boxed per server, failures ignored) and
then answers. A server that could not be reached is named in the result instead of
being silently missing.

### Hybrid mode: promote the tools you use constantly

Searching first adds a round-trip. For the handful of tools you call all the
time, set `directTools` and they are registered as normal DSH tools — zero
search latency — while the long tail stays behind the proxy:

```jsonc
{
  "mcpServers": {
    "burp-suite": {
      "type": "http",
      "url": "http://localhost:9876/mcp",
      "headers": { "Authorization": "Bearer …" },
      "directTools": true                       // small server: promote everything
    },
    "chrome": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp"],
      "directTools": ["take_screenshot", "click", "navigate"]   // promote the hot path
    },
    "falcon": {
      "command": "npx",
      "args": ["-y", "@crowdstrike/falcon-mcp"]
      // 70+ tools, occasional use → stays behind the proxy, process idle until used
    }
  }
}
```

A promoted tool appears as `mcp_<server>_<tool>` and calls the server directly.

---

## Reliability

Every design decision here serves "don't crash DSH". The adapter was tested with
deliberate fault injection — servers that crash mid-call, hang forever, emit
malformed frames, exit unprompted, or never start — and in every case the fault
becomes a clean error value, never an exception that escapes into the harness.

- **Single-settle JSON-RPC core.** Every request resolves exactly once — on
  reply, timeout, or transport close. A late reply after a timeout is ignored,
  not thrown; a dropped pipe rejects the pending request instead of hanging.
- **Hard timeouts everywhere.** Every request has a deadline on an `unref`'d
  timer, so a silent server can never wedge a turn and a pending call can never
  keep the process alive on its own.
- **Lazy connect + single-flight.** A server is contacted only on first use, and
  concurrent first-uses share one connection attempt — never a spawn storm.
- **Circuit breaker.** After repeated connect failures a breaker opens with
  exponential backoff, so a down server (Burp closed, a binary not installed)
  fails fast with a clear message instead of being hammered.
- **Transparent reconnect.** A stale HTTP session (404) or a dropped stdio pipe
  reconnects once and retries the call.
- **Idle teardown.** A connection unused past its timeout is closed to release
  the child process, then re-established on next use.
- **stdio crash containment.** Child spawn errors (`ENOENT`), broken pipes
  (`EPIPE`), and unframed floods are caught at the stream boundary and converted
  to a clean close; `SIGTERM`→`SIGKILL` escalation guarantees shutdown.
- **Output guard.** A result over the size budget keeps a head preview, spills
  the full text to a mode-`0600` temp file, and tells the model how to read the
  rest — so one big scan result cannot blow up the context or the turn.
- **Corruption-safe state.** A malformed `mcp.json` layer is skipped with a
  warning (boot continues); a corrupt cache degrades to empty; cache writes are
  atomic (temp + rename) and `0600`.

---

## Configuration

`mcp.json` is read from these locations, low → high precedence (a later file
overrides an earlier one per-server), matching pi-mcp-adapter so you can reuse
existing files:

```
~/.config/mcp/mcp.json
~/.agents/mcp.json
~/.agents/mcp/mcp.json
~/.pi/agent/mcp.json        (compatibility source)
$DSH_HOME/mcp.json          (default ~/.dsh/mcp.json)
<cwd>/.mcp.json
<cwd>/.dsh/mcp.json
```

A borrowed Pi config ranks BELOW this harness's own file: it is a compatibility
source, not an authority. (With the order reversed, a server present in both lost
its DSH-only fields — `directTools: true` on a Burp entry was silently dropped.)

### Operator visibility: `/mcp`

The proxy hides tool schemas from the model, which would also hide them from you.
`/mcp` shows what is actually happening:

```
### 🔌 MCP Adapter status

- **burp-suite** [http] — ⚫ idle (connects on first use)
  • tools: 0
  • promoted as direct tools: all
- **chrome** [stdio] — 🟢 connected
  • tools: 29 (29 cached for offline search)
  • promoted as direct tools: take_screenshot, click, navigate, evaluate_script, list_pages
```

`/mcp refresh` re-reads every server's tool catalog.

### Per-server options

| Field | Meaning |
|---|---|
| `type` | `http` / `stdio` (inferred from `url` vs `command` if omitted) |
| `url`, `headers` | HTTP transport endpoint and static headers (e.g. `Authorization`) |
| `command`, `args`, `env`, `cwd` | stdio transport spawn spec |
| `disabled` | skip this server entirely |
| `directTools` | `true` (promote all), or `["name", "glob_*"]` (promote a subset) |
| `requestTimeoutMs` | per-request timeout override for this server |
| `idleTimeoutMs` | idle disconnect timeout for this server |

### Plugin options (in `cordis.patch.yml`)

| Field | Default | Meaning |
|---|---|---|
| `servers` | – | Inline server map (merged under `mcp.json`) |
| `readConfigFiles` | `true` | Read `mcp.json` files; set `false` for inline-only |
| `requestTimeoutMs` | `60000` | Default per-request timeout |
| `idleTimeoutMs` | `300000` | Default idle disconnect |
| `toolTimeoutMs` | `120000` | Budget for the `mcp` tool itself |
| `maxOutputBytes` | `51200` | Inline output byte cap before spilling |
| `maxOutputLines` | `2000` | Inline output line cap before spilling |
| `proxy` | `true` | Register the `mcp` proxy tool |

---

## Zero dependencies

`"dependencies": {}`. Both transports (stdio and Streamable HTTP + SSE), the
JSON-RPC core, config loading, the metadata cache, ranked search, and the output
guard are written from scratch on Node built-ins. A DSH plugin is copied between
`node_modules` trees (the npx/pnpm cache and `$DSH_HOME/profiles`) where an npm
dependency may not resolve, so depending on nothing is what keeps it loadable
everywhere. The reference `pi-mcp-adapter` pulls in the MCP SDK and more; this
does not.

---

## Testing

```bash
npm test            # all three suites
node test/stdio.test.mjs   # stdio transport vs a real child server
node test/http.test.mjs    # HTTP/SSE transport vs a real node:http server
node test/suite.test.mjs   # config, cache, search, guard, manager (fault injection)
```

**108 tests passing.** The suites spawn real MCP servers (a faithful mock that can
be told to crash, hang, flood its stdout, ignore SIGTERM, stall a response body,
or frame SSE with CRLF) and assert the reliability invariants: requests always
settle, a crash rejects instead of hanging, the circuit breaker opens, a stale
connection reconnects, oversized output spills to a `0600` file, and a
four-server fault storm produces **zero unhandled rejections**.

The suite includes explicit regression tests for every issue found in the
security/reliability audit: an unbounded-stdout flood is now capped and the child
**reaped** (no OOM, no orphan); a timeout during an HTTP body read maps to
`MCP_TIMEOUT` (not a raw `AbortError`); CRLF-framed SSE parses correctly; `stop()`
returns promptly on a fast exit yet still `SIGKILL`s a stubborn child; and a
long-lived `AbortSignal` accumulates no leaked listeners across many requests.

Verified end-to-end inside a real `dsh` instance with a Burp/Chrome/Falcon-shaped
config: the `mcp` tool and promoted direct tools register, lazy connect works
(idle servers stay idle), all four actions succeed, a 3 MB result spills to a
temp file, and calling an offline server returns a clean error while DSH keeps
running.

---

## Differences from `pi-mcp-adapter`

**Adopted:** the single-proxy concept, `directTools` promotion, offline metadata
cache for search, output guarding with temp-file spill, and standard `mcp.json`
precedence.

**Different on purpose:** zero runtime dependencies (no MCP SDK); a
reliability-first connection core with an explicit circuit breaker and
single-flight connect; DSH tool-registry integration via the same `inject`
contract the harness's own tools use; and a leaner surface — no OAuth browser
flow, no interactive setup UI, no host-config auto-discovery. Those can be added
later, but they are not needed to get context-cheap, reliable MCP access.

---

## Project layout

```
lib/
├── index.js                 plugin entry: config load, wiring, registration
├── transport/
│   ├── jsonrpc.js           single-settle JSON-RPC 2.0 core
│   ├── stdio.js             child-process transport (crash/EPIPE-safe)
│   └── http.js              Streamable HTTP + SSE transport
├── core/
│   ├── config.js            layered mcp.json loader (corruption-safe)
│   ├── cache.js             atomic 0600 metadata cache (offline search)
│   ├── search.js            field-weighted tool ranking
│   ├── output-guard.js      truncate + spill oversized results
│   └── server-manager.js    lazy connect, single-flight, breaker, reconnect
└── tools/
    └── proxy.js             the mcp meta-tool + directTools promotion
```

---

## License

MIT
