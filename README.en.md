# CC Viz · Agent Office

> 🌐 **English** · [简体中文](./README.md)

A real-time visualization of Claude Code multi-agent collaboration, inspired by Tencent Marvis's "office" concept: the lead PM and its parallel sub-agents are personified as colorful little Claude Code octopuses in a **pixel-art office**. They sit at desks typing while working (the tool they're running floats above their head), wander off to grab coffee / lift weights / hit the treadmill / nap on the sofa when idle, throw out random quips (with real tool names / file names / durations / errors baked in), and two idle octopuses bumping into each other will even chat. It turns the black box of multi-agent execution into something readable and adorable.

- 🐙 **Pixel octopus staff**: each agent is an octopus in its own color (hashed from `agent_id`, matching the log dots). Typing / walking / coffee / lifting / running / napping / gaming / celebrating — a full set of frame-by-frame animations, zero image assets, all drawn at runtime from JS pixel matrices. When idle they mostly slack off gaming at their desk and only occasionally get up for the pantry / gym corner — relaxed pacing, no chaotic running around.
- 🏢 **2D office scene**: manager zone, staff desks (auto-expanding with agent count), pantry (coffee machine + water cooler), gym corner (dumbbell rack + treadmill), sofa area, plants, whiteboard.
- 💬 **Easter-egg dialogue**: work quips, crash reactions, completion celebrations, facility-specific lines, paired octopus chatter (including Warhammer 40K Adeptus Mechanicus & Octopus Union memes). Click an octopus for a detail card (current tool, duration, stats, output).
- 🌐 **Bilingual (中/EN)**: one-click toggle top-right; UI, activity log and easter-egg quips are all localized (`web/i18n.js`).
- 🔍 **Sprite debug gallery**: visit `http://127.0.0.1:4317/?debug=sprites` to preview every animation × multiple hues.

**Zero dependencies** (pure Node.js standard library + vanilla front-end), works on Windows / macOS / Linux.

---

## Screenshot spot

After starting, open `http://127.0.0.1:4317/` and click「▶ Demo」top-right to watch a built-in script (PM breaks down a task → 3 sub-agents in parallel refactor / write tests / update docs) run end to end.

---

## 30-second start

```bash
# 1. Start the server (zero deps, no npm install needed)
node server/server.mjs          # or: npm start

# 2. Open the panel, hit「▶ Demo」first to feel it out
#    http://127.0.0.1:4317/

# 3. Hook up real Claude Code sessions: register hooks
node install.mjs                 # install globally, captures all your sessions
#   or node install.mjs --project  to capture only the current project

# 4. Open a new Claude Code session and give it some work (especially
#    tasks that spawn sub-agents) — the office comes alive in real time.
```

Uninstall hooks: `node install.mjs --uninstall` (auto-backs up, removes only entries this tool wrote).

---

## Architecture

Three layers, one-way data flow:

```
Claude Code session
   │  hooks (type:http, one JSON POST per lifecycle event)
   ▼
local server  server/server.mjs
   ├─ /event      ingest hook events
   ├─ state.mjs   reduce into "session / agent / tool-call" three-layer state
   └─ /events     SSE live state-snapshot push
   ▼
front-end  web/  ──  office desks + live activity log
```

- **Transport via SSE (not WebSocket)**: server→browser one-way push is exactly enough, natively supported by the Node standard library, zero install friction.
- **Hooks as the sole data source**: in practice it's enough for precise multi-agent attribution, no need to tail the transcript.

---

## Key technical findings (verified on Claude Code 2.1.156)

The original design worry was "parallel sub-agents share a session ID, so you can't tell which sub-agent is doing what." **In practice this pitfall no longer exists in current versions**:

| Finding | Evidence |
|---|---|
| Every tool-call hook payload carries **`agent_id`** — zero ambiguity in sub-agent attribution | Two parallel sub-agents' `echo` calls carry different `agent_id`s |
| The main agent's `agent_id` is empty (the root); its `Agent` tool call IS "dispatching" | tool=`Agent`, no agent_id |
| `SubagentStart` / `SubagentStop` really fire, both with `agent_id` + `agent_type` | 2 starts 2 stops, each with its own id |
| `PreToolUse`/`PostToolUse` carry `tool_use_id` (pairs before/after) + `duration_ms` + `tool_response` | — |
| `SubagentStop` also carries `last_assistant_message` + the sub-agent's own transcript path | output retrievable |
| **`type:"http"` hooks work**: Claude Code POSTs events straight to the local server, no per-event subprocess | all real-session events arrived |
| On Windows, command/http hook stdin/transport both work (incl. `Stop` event) | — |

> Repro scripts in `experiment/`: `hook-capture.mjs` (capture real payloads to `captured.log`), `smoke.mjs` (simulate event sequences to verify the state machine).

Selected real payload fields observed:

```
PreToolUse  → agent_id, agent_type, tool_name, tool_input, tool_use_id, permission_mode, session_id, transcript_path, hook_event_name, cwd
PostToolUse → above + duration_ms, tool_response
SubagentStop→ agent_id, agent_type, last_assistant_message, agent_transcript_path, session_id, ...
```

---

## Directory layout

```
CC可视化/
├─ server/
│  ├─ server.mjs     HTTP ingest + SSE push + static hosting + demo endpoint + managed-session API
│  ├─ state.mjs      hook event → visualization state reduction (core)
│  ├─ models.mjs     read transcript tail to extract each agent's current model
│  ├─ managed.mjs    spawn & manage long-lived `claude -p` stream-json child processes
│  └─ approve-mcp.mjs zero-dep stdio MCP server backing the permission-approval card
├─ web/
│  ├─ index.html     office + sidebar layout
│  ├─ i18n.js        bilingual dictionary + t() engine + data-i18n sweep
│  ├─ app.js         SSE subscribe, topbar/log render, drives Office/Dialogue
│  ├─ sprites.js     pixel sprite system (octopus frames + furniture + palette + debug gallery)
│  ├─ office.js      2D office scene (layout, wander FSM, rAF loop, detail card)
│  ├─ dialogue.js    easter-egg dialogue (bilingual quip pools + real-data injection + paired chat)
│  └─ styles.css     panel visuals, bubble/nameplate/detail-card styles
├─ hooks/
│  └─ hooks.json     standard hook config (type:http, ready to reference / package as a plugin)
├─ install.mjs       idempotently merges hooks into settings.json (supports --project / --uninstall)
├─ experiment/       tech-validation sandbox (payload capture + state-machine smoke test)
├─ .claude/launch.json
└─ package.json
```

---

## Customization

- **UI text / language**: all UI and activity-log strings live in `web/i18n.js` under `DICT.{zh,en}`; to add a third language, copy a language block.
- **Role names**: the `role.*` keys in `web/i18n.js` (e.g. `role.Explore`) give common `subagent_type`s their display names; tool icons live in `TOOL_IC` in `web/app.js`.
- **Octopus look / animation**: `web/sprites.js` is all string pixel matrices (one char = one pixel); change a few chars to reskin; preview live in the `?debug=sprites` gallery.
- **Quip library**: `WORK_BY_TOOL` / `ERROR_QUIPS` / `FACILITY_QUIPS` / `CHAT_PAIRS` etc. at the top of `web/dialogue.js`, all split by `{zh,en}`, supporting `{tool}{file}{dur}{n}{err}{msg}` placeholders.
- **Office layout**: `FACILITIES` / `DECOR` / desk constants at the top of `web/office.js` — change coordinates to move furniture.
- **State reduction**: all "event → state" logic is centralized in `server/state.mjs`; add fields (e.g. token usage, error highlighting) here.
- **Port**: `CC_VIZ_PORT=5000 node server/server.mjs`, sync at install with `node install.mjs --port 5000`.

---

## Advanced capabilities (implemented)

- **Multi-session floors**: split by `session_id` into sessions, grouped by `cwd` into floors (left-side elevator nav); concurrent sessions don't interfere; ended sessions are cleaned after 10 min, capped at 16 with LRU eviction (`server/state.mjs`).
- **Model badge**: each agent's nameplate shows its current model (e.g. `fable-5`, `haiku-4.5`), extracted server-side from the transcript JSONL tail (`server/models.mjs`; sub-agent transcripts live at `<session-dir>/subagents/agent-<id>.jsonl`).
- **Storage-shelf boxes**: directories touched by tool calls become cardboard boxes on a shelf; when an agent switches working directory it walks over to fetch the matching box back to its desk and returns it when done (`dirOf` in `state.mjs` + the PICKING/return FSM in `office.js`).
- **Resident sessions (command from inside the viz)**: 「➕ New session」on the left spawns a long-lived `claude -p` stream-json process in a given path (`server/managed.mjs`), with optional model and permission mode; the prompt bar below the office dispatches commands directly; idle 30 min → auto-sleep, sending again wakes it via `--resume`. Sessions opened in a terminal remain read-only observation (you can't inject input into an interactive terminal).
- **Permission approval card**: resident sessions mount `--permission-prompt-tool` (`server/approve-mcp.mjs`, a zero-dep stdio MCP); operations needing permission (e.g. `git push`) pop a red approval card below the office — click「Allow / Always allow this session / Deny」and the decision is returned via long-polling. The CLI's permission prompt, fully brought into the viz.
- **Full conversation panel**: the sidebar「💬 Full Conversation」shows your prompts and the assistant's complete replies in order (the activity log keeps only a 200-char summary), so you never miss "needs your approval" moments.
- **Stability**: crash stacks are written to `%TEMP%\cc-viz-crash.log`; managed child PIDs are recorded in a temp file and orphans are reaped on server restart.

## Known boundaries / next steps

- The `tool_use_id` of an `Agent` dispatch isn't strongly linked to the sub-agent's `agent_id` yet (shown by timing / parent-child hierarchy, which is enough); for precise wiring, read the `SubagentStop` transcript to match.
- After a resident session sleeps, waking via `--resume` forks a new `session_id` (a new room appears in the floor to continue the conversation; the old room keeps its history).
- Roadmap: ① DAG / timeline view toggle (higher info density); ② token / duration stats panel; ③ package as a Claude Code plugin (`hooks/hooks.json` is ready, drop it into the plugin's `hooks/` dir).

---

## Does it affect my session if the server isn't running?

No. Hooks are `type:http`; when the server is down the connection fails instantly (a localhost connection refusal is immediate), Claude Code treats it as a non-blocking error and ignores it, and your session proceeds as normal.
