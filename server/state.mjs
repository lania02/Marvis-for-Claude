// 把 Claude Code hook 事件归约成可视化状态：会话 / agent / 工具调用三层。
// 关键：用 agent_id 做精确归属——主 agent 的 agent_id 为空（根节点），
// 每个子 agent 拥有独立 agent_id，每次工具调用都带上发起它的 agent_id。
// 多会话：sessions = Map<sessionId, state>，按 cwd 分组成"楼层"（index()）。

const ROOT = "root";
const MAX_TOOLS = 300;
const MAX_FEED = 200;
const MAX_SESSIONS = 16; // 会话硬上限，超出按 LRU 淘汰（ended 优先，running 永不淘汰）
const ENDED_TTL = 10 * 60 * 1000; // ended 会话保留 10 分钟

function nowISO() {
  return new Date().toISOString();
}

function baseName(p) {
  if (!p) return "";
  const segs = String(p).split(/[\\/]+/).filter(Boolean);
  return segs[segs.length - 1] || p;
}

// 把 tool_input 压成一句人话，给"工位气泡"和日志用
function summarizeInput(toolName, input) {
  if (!input || typeof input !== "object") return "";
  const pick = (...keys) => {
    for (const k of keys) if (input[k] != null && input[k] !== "") return String(input[k]);
    return "";
  };
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      return pick("command", "description");
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return pick("file_path", "notebook_path");
    case "Glob":
      return pick("pattern");
    case "Grep":
      return pick("pattern");
    case "Agent":
    case "Task": {
      const t = pick("subagent_type");
      const d = pick("description", "prompt");
      return [t, d].filter(Boolean).join(" · ");
    }
    case "WebFetch":
    case "WebSearch":
      return pick("url", "query", "prompt");
    default: {
      // 兜底：取第一个字符串字段
      for (const v of Object.values(input)) {
        if (typeof v === "string" && v.trim()) return v;
      }
      return "";
    }
  }
}

function summarizeResponse(resp) {
  if (resp == null) return "";
  let s = typeof resp === "string" ? resp : JSON.stringify(resp);
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 240 ? s.slice(0, 240) + "…" : s;
}

function clip(s, n) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const SPAWN_TOOLS = new Set(["Agent", "Task"]);

// ---- F3:从工具调用提取"工作目录"(办公室储物架的箱子) ----
const MAX_DIRS = 12;
const FILE_TOOLS = new Set(["Read", "Write", "Edit", "NotebookEdit"]);
const DIR_TOOLS = new Set(["Glob", "Grep"]);

// 返回目录键(相对 cwd 的前两段,如 "src/auth"),提不出来返回 null
function dirOf(toolName, input, cwd) {
  if (!input || typeof input !== "object") return null;
  let raw = null;
  let isFile = false;
  if (FILE_TOOLS.has(toolName)) {
    raw = input.file_path || input.notebook_path;
    isFile = true;
  } else if (DIR_TOOLS.has(toolName)) {
    raw = input.path;
  }
  if (!raw) return null;
  let p = String(raw).replace(/\//g, "\\");
  if (cwd) {
    const c = String(cwd).replace(/\//g, "\\").replace(/\\+$/, "");
    if (p.toLowerCase().startsWith(c.toLowerCase())) p = p.slice(c.length);
  }
  p = p.replace(/^\\+/, "");
  // 还是绝对路径 → 在 cwd 之外,取末段目录名当箱子
  if (/^[a-z]:\\/i.test(p)) {
    const segs = p.split("\\").filter(Boolean);
    if (isFile) segs.pop();
    return segs.length ? "⋯/" + segs[segs.length - 1] : null;
  }
  const segs = p.split("\\").filter(Boolean);
  if (isFile) segs.pop(); // 去掉文件名
  if (!segs.length) return "(root)";
  return segs.slice(0, 2).join("/");
}

function touchDir(s, dir) {
  const d = (s.dirs[dir] ||= { dir, label: dir.length > 10 ? dir.slice(0, 9) + "…" : dir, count: 0, lastAt: null });
  d.count += 1;
  d.lastAt = nowISO();
  const keys = Object.keys(s.dirs);
  if (keys.length > MAX_DIRS) {
    keys.sort((a, b) => Date.parse(s.dirs[a].lastAt) - Date.parse(s.dirs[b].lastAt));
    for (const k of keys.slice(0, keys.length - MAX_DIRS)) delete s.dirs[k];
  }
}

export function createStore() {
  const sessions = new Map(); // sessionId -> state
  let lastSessionId = null; // 兜底：无 session_id 的事件归到最近会话

  function freshRun(sessionId) {
    return {
      sessionId: sessionId || null,
      cwd: null, // 楼层分组键，取首个带 cwd 的 hook
      status: "idle", // idle | running | done
      ended: false, // SessionEnd 之后为 true，供 sweep 清理
      endedAt: null,
      managed: false, // F2：是否为可视化自管会话
      startedAt: nowISO(),
      updatedAt: nowISO(),
      lastPrompt: "",
      agents: {
        [ROOT]: {
          key: ROOT,
          id: null,
          type: "main",
          role: "主控 · PM",
          status: "idle", // idle | working | done
          startedAt: nowISO(),
          endedAt: null,
          currentToolId: null,
          toolCount: 0,
          spawnCount: 0,
          lastMessage: "",
          model: null, // 缩写模型名,server 端从 transcript 异步补充
          currentDir: null, // F3:当前工作目录(对应储物架箱子)
        },
      },
      tools: [], // 按时间顺序
      feed: [], // 活动日志（最新在前）
      dirs: {}, // F3:出现过的工作目录(储物架箱子),dir -> {dir,label,count,lastAt}
      stats: { totalTools: 0, totalAgents: 0 },
    };
  }

  function agentKeyOf(p) {
    return p.agent_id || ROOT;
  }

  function ensureAgent(s, p) {
    const key = agentKeyOf(p);
    if (!s.agents[key]) {
      s.agents[key] = {
        key,
        id: p.agent_id || null,
        type: p.agent_type || "subagent",
        role: p.agent_type || "子 agent",
        status: "working",
        startedAt: nowISO(),
        endedAt: null,
        currentToolId: null,
        toolCount: 0,
        spawnCount: 0,
        lastMessage: "",
        model: null,
        currentDir: null,
      };
      s.stats.totalAgents = Object.keys(s.agents).length;
    }
    return s.agents[key];
  }

  function pushFeed(s, entry) {
    s.feed.unshift({ at: nowISO(), ...entry });
    if (s.feed.length > MAX_FEED) s.feed.length = MAX_FEED;
  }

  function findTool(s, id) {
    if (!id) return null;
    for (let i = s.tools.length - 1; i >= 0; i--) {
      if (s.tools[i].id === id) return s.tools[i];
    }
    return null;
  }

  function reduce(s, p) {
    const ev = p.hook_event_name || "Unknown";

    switch (ev) {
      case "SessionStart": {
        s.status = "running";
        pushFeed(s, { kind: "session", text: `会话开始（${p.source || "startup"}）` });
        break;
      }

      case "UserPromptSubmit": {
        s.status = "running";
        s.ended = false;
        s.lastPrompt = clip(p.prompt, 400);
        const root = s.agents[ROOT];
        root.status = "working";
        pushFeed(s, { kind: "prompt", agent: ROOT, text: `用户：${clip(p.prompt, 120)}` });
        break;
      }

      case "SubagentStart": {
        const a = ensureAgent(s, p);
        a.status = "working";
        a.startedAt = nowISO();
        pushFeed(s, { kind: "spawn", agent: a.key, agentType: a.type, text: `子 agent 上线：${a.type}` });
        break;
      }

      case "PreToolUse": {
        const a = ensureAgent(s, p);
        a.status = "working";
        const dir = dirOf(p.tool_name, p.tool_input, s.cwd);
        if (dir) {
          a.currentDir = dir;
          touchDir(s, dir);
        }
        const summary = summarizeInput(p.tool_name, p.tool_input);
        if (SPAWN_TOOLS.has(p.tool_name)) {
          a.spawnCount += 1;
          pushFeed(s, { kind: "dispatch", agent: a.key, text: `派活 → ${summary}` });
        }
        const tool = {
          id: p.tool_use_id || `${a.key}:${s.tools.length}`,
          agentKey: a.key,
          agentType: a.type,
          name: p.tool_name,
          isSpawn: SPAWN_TOOLS.has(p.tool_name),
          input: summary,
          status: "running",
          startedAt: nowISO(),
          endedAt: null,
          durationMs: null,
          response: "",
        };
        s.tools.push(tool);
        if (s.tools.length > MAX_TOOLS) s.tools.splice(0, s.tools.length - MAX_TOOLS);
        a.currentToolId = tool.id;
        a.toolCount += 1;
        s.stats.totalTools += 1;
        pushFeed(s, { kind: "tool", agent: a.key, tool: p.tool_name, text: `${p.tool_name}：${clip(summary, 100)}` });
        break;
      }

      case "PostToolUse":
      case "PostToolUseFailure": {
        const a = ensureAgent(s, p);
        const tool = findTool(s, p.tool_use_id);
        const ok = ev !== "PostToolUseFailure";
        if (tool) {
          tool.status = ok ? "ok" : "error";
          tool.endedAt = nowISO();
          tool.durationMs = typeof p.duration_ms === "number" ? p.duration_ms : null;
          tool.response = summarizeResponse(ok ? p.tool_response : p.error);
        }
        if (a.currentToolId === (p.tool_use_id || null)) a.currentToolId = null;
        if (!ok) pushFeed(s, { kind: "error", agent: a.key, tool: p.tool_name, text: `失败：${p.tool_name}` });
        break;
      }

      case "SubagentStop": {
        const a = ensureAgent(s, p);
        a.status = "done";
        a.endedAt = nowISO();
        a.currentToolId = null;
        a.currentDir = null;
        a.lastMessage = clip(p.last_assistant_message, 280);
        pushFeed(s, { kind: "done", agent: a.key, agentType: a.type, text: `子 agent 完成：${a.type}` });
        break;
      }

      case "Stop":
      case "StopFailure": {
        const root = s.agents[ROOT];
        root.status = "done";
        root.currentToolId = null;
        root.currentDir = null;
        if (p.last_assistant_message) root.lastMessage = clip(p.last_assistant_message, 280);
        s.status = "done";
        pushFeed(s, { kind: "session", agent: ROOT, text: ev === "StopFailure" ? "会话异常结束" : "本轮完成" });
        break;
      }

      case "SessionEnd": {
        s.status = "done";
        s.ended = true;
        s.endedAt = nowISO();
        pushFeed(s, { kind: "session", text: "会话结束" });
        break;
      }

      default:
        pushFeed(s, { kind: "other", text: `事件：${ev}` });
    }
  }

  // 清理：ended 超时删除；超过硬上限按 LRU 淘汰（ended 优先，running 永不淘汰）
  function sweep() {
    const nowMs = Date.now();
    for (const [sid, s] of sessions) {
      if (s.ended && s.endedAt && nowMs - Date.parse(s.endedAt) > ENDED_TTL) sessions.delete(sid);
    }
    if (sessions.size <= MAX_SESSIONS) return;
    const victims = [...sessions.values()]
      .filter((s) => s.status !== "running")
      .sort((a, b) => (a.ended !== b.ended ? (a.ended ? -1 : 1) : Date.parse(a.updatedAt) - Date.parse(b.updatedAt)));
    for (const s of victims) {
      if (sessions.size <= MAX_SESSIONS) break;
      sessions.delete(s.sessionId);
    }
  }

  // 核心：吃进一条 hook payload，更新对应会话，返回 sessionId
  function ingest(p) {
    const sid = p.session_id || lastSessionId || "unknown";
    lastSessionId = sid;
    let s = sessions.get(sid);
    if (p.hook_event_name === "SessionStart" || !s) {
      s = freshRun(sid);
      sessions.set(sid, s);
    }
    if (!s.cwd && p.cwd) s.cwd = p.cwd;
    s.updatedAt = nowISO();
    reduce(s, p);
    sweep();
    return sid;
  }

  // 楼层摘要：按 cwd 分组，楼层间/层内均按 updatedAt 倒序
  function index() {
    const byCwd = new Map();
    for (const s of sessions.values()) {
      const cwd = s.cwd || "(演示)";
      if (!byCwd.has(cwd)) byCwd.set(cwd, []);
      byCwd.get(cwd).push(s);
    }
    const floors = [...byCwd.entries()].map(([cwd, list]) => {
      list.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return {
        cwd,
        name: baseName(cwd),
        updatedAt: list[0].updatedAt,
        sessions: list.map((s) => ({
          sessionId: s.sessionId,
          status: s.status,
          ended: s.ended,
          managed: s.managed,
          startedAt: s.startedAt,
          updatedAt: s.updatedAt,
          agentCount: Math.max(0, Object.keys(s.agents).length - 1),
          totalTools: s.stats.totalTools,
          lastPrompt: clip(s.lastPrompt, 60),
        })),
      };
    });
    floors.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return floors;
  }

  return {
    ingest,
    index,
    snapshot: (sid) => sessions.get(sid) || null,
    all: () => Object.fromEntries(sessions),
    setManaged: (sid) => {
      const s = sessions.get(sid);
      if (s) s.managed = true;
      return !!s;
    },
    // F2:自管会话创建后立即占一个房间(hooks 要等第一条指令才会触发)
    ensureSession: (sid, cwd) => {
      let s = sessions.get(sid);
      if (!s) {
        s = freshRun(sid);
        s.cwd = cwd || null;
        sessions.set(sid, s);
      }
      s.managed = true;
      return s;
    },
    // F4:回填模型名,返回是否发生变化(变化才值得 broadcast)
    setAgentModel: (sid, agentKey, model) => {
      const a = sessions.get(sid)?.agents[agentKey];
      if (!a || a.model === model) return false;
      a.model = model;
      return true;
    },
    // F2:自管会话的 assistant 回复落进活动日志
    pushReply: (sid, text) => {
      const s = sessions.get(sid);
      if (!s) return false;
      s.updatedAt = nowISO();
      pushFeed(s, { kind: "reply", agent: ROOT, text: clip(text, 200) });
      return true;
    },
    reset: () => {
      sessions.clear();
      lastSessionId = null;
    },
  };
}
