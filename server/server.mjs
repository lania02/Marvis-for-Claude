// CC 可视化 · 本地采集与推送服务（纯 Node 标准库，零依赖）
//   POST /event       接收 Claude Code hook 事件
//   GET  /events      SSE 实时推送状态快照
//   GET  /api/state   当前完整快照（供后加入的客户端）
//   POST /api/reset   清空当前会话状态
//   GET  /            前端（web/）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { createStore } from "./state.mjs";
import { modelFor } from "./models.mjs";
import { createManager, reapOrphans } from "./managed.mjs";
import { createQuipGen } from "./quips.mjs";

// 大声失败:崩溃前把堆栈落盘(之前出现过无痕死亡,死也要留尸检报告)
const CRASH_LOG = path.join(os.tmpdir(), "cc-viz-crash.log");
for (const ev of ["uncaughtException", "unhandledRejection"]) {
  process.on(ev, (err) => {
    const line = `[${new Date().toISOString()}] ${ev}: ${err?.stack || err}\n`;
    console.error(line);
    try {
      fs.appendFileSync(CRASH_LOG, line);
    } catch { /* ignore */ }
    if (ev === "uncaughtException") process.exit(1);
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, "..", "web");
const PORT = Number(process.env.CC_VIZ_PORT) || 4317;
const HOST = process.env.CC_VIZ_HOST || "127.0.0.1";

const store = createStore();
const clients = new Set();

function sseSend(res, msg) {
  try {
    res.write(`data: ${JSON.stringify(msg)}\n\n`);
  } catch {
    clients.delete(res);
  }
}

// 定向广播：只推送发生变化的那个会话的全量 state + 楼层摘要
function broadcast(sid) {
  const msg = { kind: "update", sessionId: sid, index: store.index(), state: store.snapshot(sid) };
  for (const res of clients) sseSend(res, msg);
}

function helloMsg() {
  return {
    kind: "hello",
    index: store.index(),
    states: store.all(),
    managedOk: manager.available,
    approvals: [...approvals.values()].filter((a) => !a.decision).map(publicApproval),
  };
}

function broadcastHello() {
  const msg = helloMsg();
  for (const res of clients) sseSend(res, msg);
}

// ---- 审批通道:approve-mcp.mjs 转发的权限请求,等前端用户拍板 ----
const approvals = new Map(); // id -> {id, sessionId, toolName, summary, input, createdAt, decision, waiters: []}
const autoAllow = new Map(); // sessionId -> Set(toolName) "本会话总是允许"

function approvalSummary(toolName, input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "file_path", "pattern", "url", "query", "prompt", "description"]) {
    if (typeof input[k] === "string" && input[k]) return input[k].slice(0, 200);
  }
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return "";
  }
}

function publicApproval(a) {
  return { id: a.id, sessionId: a.sessionId, toolName: a.toolName, summary: a.summary, createdAt: a.createdAt };
}

function settleApproval(a, decision) {
  a.decision = decision;
  for (const w of a.waiters.splice(0)) w(decision);
  const msg = { kind: "approval_done", id: a.id, sessionId: a.sessionId, behavior: decision.behavior };
  for (const res of clients) sseSend(res, msg);
  setTimeout(() => approvals.delete(a.id), 10 * 60 * 1000).unref?.();
}

// ---- AI 台词生成(haiku 一次性调用;其会话的 hooks 全部忽略) ----
const ignoredSids = new Set();
const quipGen = createQuipGen((sid) => ignoredSids.add(sid));

// ---- F2:自管会话(可视化内直接发指令) ----
reapOrphans(); // 上次 server 异常退出留下的自管子进程,先清掉
const managedIds = new Set(); // 自管 session_id;hook 进来时补打 managed 标
const manager = createManager((kind, data) => {
  if (kind === "init") {
    managedIds.add(data.sessionId);
    store.setManaged(data.sessionId);
  } else if (kind === "reply") {
    // 回复落进该会话的活动日志,走正常 update 广播(持久 + 复用渲染)
    if (store.pushReply(data.sessionId, data.text)) broadcast(data.sessionId);
  } else if (kind === "status") {
    const msg = { kind: "mstatus", sessionId: data.sessionId, status: data.status, queued: data.queued };
    for (const res of clients) sseSend(res, msg);
  }
}, { port: PORT });

const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const validSid = (s) => typeof s === "string" && /^[0-9a-f-]{8,40}$/i.test(s);

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(WEB_DIR, urlPath);
  // 防目录穿越
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // hook 事件采集
  if (req.method === "POST" && url === "/event") {
    const body = await readBody(req);
    try {
      const payload = JSON.parse(body);
      if (payload.session_id && ignoredSids.has(payload.session_id)) {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return; // AI 台词生成会话,不进可视化
      }
      const sid = store.ingest(payload);
      if (managedIds.has(sid)) store.setManaged(sid); // SessionStart 的 freshRun 会重置标记,这里补回
      broadcast(sid);
      // F4:从 transcript 异步补模型名(fire-and-forget,有 TTL 缓存节流)
      const ev = payload.hook_event_name;
      if (ev === "PreToolUse" || ev === "SubagentStop") {
        modelFor(payload, ev === "SubagentStop")
          .then((model) => {
            if (model && store.setAgentModel(sid, payload.agent_id || "root", model)) broadcast(sid);
          })
          .catch(() => {});
      }
    } catch (e) {
      // 不让 hook 因为我们的错误而阻塞，照常返回 200
      console.error("[event] parse error:", e.message);
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }

  // SSE 实时流
  if (req.method === "GET" && url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`retry: 2000\n\n`);
    res.write(`data: ${JSON.stringify(helloMsg())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* ignore */
      }
    }, 25000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && url === "/api/state") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(helloMsg()));
    return;
  }

  if (req.method === "POST" && url === "/api/reset") {
    store.reset();
    broadcastHello();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    return;
  }

  // ---- F2:自管会话端点(仅本机) ----
  if (req.method === "POST" && url === "/api/session") {
    if (!isLocal(req)) return json(res, 403, { error: "local_only" });
    if (!manager.available) return json(res, 501, { error: "claude_not_found" });
    const body = await readBody(req);
    let cwd, model, permissionMode;
    try {
      ({ cwd, model, permissionMode } = JSON.parse(body));
      cwd = String(cwd || "").trim();
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
    try {
      if (!cwd || !fs.statSync(cwd).isDirectory()) throw new Error();
    } catch {
      return json(res, 400, { error: "cwd_not_dir" });
    }
    try {
      const { sessionId } = await manager.createSession(cwd, { model, permissionMode });
      store.ensureSession(sessionId, cwd); // 房间立即可见,等待第一条指令
      broadcast(sessionId);
      return json(res, 200, { sessionId });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  }

  // ---- AI 台词生成:GET /api/quip?sid=&lang= → {lines:[...]|null} ----
  if (req.method === "GET" && url === "/api/quip") {
    if (!isLocal(req)) return json(res, 403, { error: "local_only" });
    const q = new URLSearchParams(req.url.split("?")[1] || "");
    const sid = q.get("sid");
    const lang = q.get("lang") === "en" ? "en" : "zh";
    const s = sid && store.snapshot(sid);
    if (!s || !quipGen.available) return json(res, 200, { lines: null });
    // 上下文:任务 + 最近日志(code+参数拼成朴素文本,够 LLM 用)
    const log = (s.feed || []).slice(0, 12).map((f) => `- ${f.kind}: ${[f.tool, f.arg].filter(Boolean).join(" ")}`).reverse();
    const ctx = [s.lastPrompt ? `task: ${s.lastPrompt}` : "", ...log].filter(Boolean).join("\n");
    const lines = await quipGen.generate(sid, lang, ctx || "(no log yet)");
    return json(res, 200, { lines });
  }

  // ---- 审批通道(approve-mcp.mjs ↔ 前端) ----
  if (req.method === "POST" && url === "/api/approval/request") {
    if (!isLocal(req)) return json(res, 403, { error: "local_only" });
    const body = await readBody(req);
    let sessionId, toolName, input;
    try {
      ({ sessionId, toolName, input } = JSON.parse(body));
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
    toolName = String(toolName || "unknown").slice(0, 80);
    if (autoAllow.get(sessionId)?.has(toolName)) {
      return json(res, 200, { decision: { behavior: "allow" } }); // 命中"本会话总是允许"
    }
    const a = {
      id: randomUUID(),
      sessionId: sessionId || null,
      toolName,
      summary: approvalSummary(toolName, input),
      createdAt: new Date().toISOString(),
      decision: null,
      waiters: [],
    };
    approvals.set(a.id, a);
    const msg = { kind: "approval", approval: publicApproval(a) };
    for (const c of clients) sseSend(c, msg);
    return json(res, 200, { id: a.id });
  }

  if (req.method === "GET" && url === "/api/approval/wait") {
    const id = new URLSearchParams(req.url.split("?")[1] || "").get("id");
    const a = approvals.get(id);
    if (!a) return json(res, 404, { error: "unknown_approval" });
    if (a.decision) return json(res, 200, { decision: a.decision });
    // 长轮询:挂 25 秒,有决定立刻返回
    const timer = setTimeout(() => {
      const i = a.waiters.indexOf(waiter);
      if (i >= 0) a.waiters.splice(i, 1);
      json(res, 200, { pending: true });
    }, 25000);
    const waiter = (decision) => {
      clearTimeout(timer);
      json(res, 200, { decision });
    };
    a.waiters.push(waiter);
    req.on("close", () => {
      clearTimeout(timer);
      const i = a.waiters.indexOf(waiter);
      if (i >= 0) a.waiters.splice(i, 1);
    });
    return;
  }

  if (req.method === "POST" && url === "/api/approval/decide") {
    if (!isLocal(req)) return json(res, 403, { error: "local_only" });
    const body = await readBody(req);
    let id, behavior, message, always;
    try {
      ({ id, behavior, message, always } = JSON.parse(body));
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
    const a = approvals.get(id);
    if (!a) return json(res, 404, { error: "unknown_approval" });
    if (a.decision) return json(res, 200, { ok: true }); // 重复点按,幂等
    behavior = behavior === "allow" ? "allow" : "deny";
    if (behavior === "allow" && always && a.sessionId) {
      (autoAllow.get(a.sessionId) || autoAllow.set(a.sessionId, new Set()).get(a.sessionId)).add(a.toolName);
    }
    settleApproval(a, { behavior, message: message ? String(message).slice(0, 300) : undefined });
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/api/prompt") {
    if (!isLocal(req)) return json(res, 403, { error: "local_only" });
    if (!manager.available) return json(res, 501, { error: "claude_not_found" });
    const body = await readBody(req);
    let sessionId, prompt;
    try {
      ({ sessionId, prompt } = JSON.parse(body));
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
    if (!validSid(sessionId)) return json(res, 400, { error: "bad_session_id" });
    prompt = String(prompt || "").slice(0, 8000);
    if (!prompt.trim()) return json(res, 400, { error: "empty_prompt" });
    const r = manager.sendPrompt(sessionId, prompt);
    return json(res, r.ok ? 200 : r.code, r);
  }

  if (req.method === "POST" && url === "/api/session/stop") {
    if (!isLocal(req)) return json(res, 403, { error: "local_only" });
    const body = await readBody(req);
    let sessionId;
    try {
      sessionId = JSON.parse(body).sessionId;
    } catch {
      return json(res, 400, { error: "bad_json" });
    }
    if (!validSid(sessionId)) return json(res, 400, { error: "bad_session_id" });
    return json(res, 200, { stopped: manager.stopSession(sessionId) });
  }

  // 演示回放：不接 hook 也能看到办公室动起来
  if (req.method === "POST" && url === "/api/demo") {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    playDemo();
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405).end("method not allowed");
});

// ---- 演示剧本：PM 拆解任务 → 三个子 agent 并行干活 ----
const G = "general-purpose";
const AG1 = "demo-refactor-001";
const AG2 = "demo-tests-002";
const AG3 = "demo-docs-003";
const DEMO = [
  [0, { hook_event_name: "SessionStart", session_id: "demo", source: "startup" }],
  [200, { hook_event_name: "UserPromptSubmit", session_id: "demo", prompt: "帮我重构登录模块、补齐单元测试，并更新相关文档" }],
  [500, { hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "d_r1", tool_input: { file_path: "src/auth/login.ts" } }],
  [700, { hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "d_r1", duration_ms: 180, tool_response: "ok 220 行" }],
  [400, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "d_s1", tool_input: { subagent_type: G, description: "重构登录模块" } }],
  [120, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "d_s2", tool_input: { subagent_type: G, description: "编写单元测试" } }],
  [120, { hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "d_s3", tool_input: { subagent_type: "Explore", description: "梳理并更新文档" } }],
  [200, { hook_event_name: "SubagentStart", agent_id: AG1, agent_type: G }],
  [60, { hook_event_name: "SubagentStart", agent_id: AG2, agent_type: G }],
  [60, { hook_event_name: "SubagentStart", agent_id: AG3, agent_type: "Explore" }],

  [300, { hook_event_name: "PreToolUse", agent_id: AG1, agent_type: G, tool_name: "Read", tool_use_id: "a1t1", tool_input: { file_path: "src/auth/login.ts" } }],
  [200, { hook_event_name: "PreToolUse", agent_id: AG3, agent_type: "Explore", tool_name: "Grep", tool_use_id: "a3t1", tool_input: { pattern: "login\\(" } }],
  [250, { hook_event_name: "PreToolUse", agent_id: AG2, agent_type: G, tool_name: "Read", tool_use_id: "a2t1", tool_input: { file_path: "src/auth/login.test.ts" } }],
  [400, { hook_event_name: "PostToolUse", agent_id: AG1, agent_type: G, tool_name: "Read", tool_use_id: "a1t1", duration_ms: 210, tool_response: "ok" }],
  [150, { hook_event_name: "PostToolUse", agent_id: AG3, agent_type: "Explore", tool_name: "Grep", tool_use_id: "a3t1", duration_ms: 90, tool_response: "命中 7 处" }],
  [200, { hook_event_name: "PostToolUse", agent_id: AG2, agent_type: G, tool_name: "Read", tool_use_id: "a2t1", duration_ms: 160, tool_response: "ok" }],

  [300, { hook_event_name: "PreToolUse", agent_id: AG1, agent_type: G, tool_name: "Edit", tool_use_id: "a1t2", tool_input: { file_path: "src/auth/login.ts" } }],
  [200, { hook_event_name: "PreToolUse", agent_id: AG2, agent_type: G, tool_name: "Write", tool_use_id: "a2t2", tool_input: { file_path: "src/auth/login.test.ts" } }],
  [250, { hook_event_name: "PreToolUse", agent_id: AG3, agent_type: "Explore", tool_name: "Read", tool_use_id: "a3t2", tool_input: { file_path: "docs/auth.md" } }],
  [500, { hook_event_name: "PostToolUse", agent_id: AG3, agent_type: "Explore", tool_name: "Read", tool_use_id: "a3t2", duration_ms: 140, tool_response: "ok" }],
  [200, { hook_event_name: "SubagentStop", agent_id: AG3, agent_type: "Explore", last_assistant_message: "文档结构已梳理：建议更新 3 处登录流程说明。" }],
  [100, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "d_s3", duration_ms: 2400, tool_response: "ok" }],

  [400, { hook_event_name: "PostToolUse", agent_id: AG1, agent_type: G, tool_name: "Edit", tool_use_id: "a1t2", duration_ms: 620, tool_response: "已重构为 async/await" }],
  [150, { hook_event_name: "PreToolUse", agent_id: AG1, agent_type: G, tool_name: "Bash", tool_use_id: "a1t3", tool_input: { command: "npm run typecheck" } }],
  [300, { hook_event_name: "PostToolUse", agent_id: AG2, agent_type: G, tool_name: "Write", tool_use_id: "a2t2", duration_ms: 700, tool_response: "新增 12 个用例" }],
  [200, { hook_event_name: "PreToolUse", agent_id: AG2, agent_type: G, tool_name: "Bash", tool_use_id: "a2t3", tool_input: { command: "npm test -- login" } }],
  [600, { hook_event_name: "PostToolUse", agent_id: AG1, agent_type: G, tool_name: "Bash", tool_use_id: "a1t3", duration_ms: 1400, tool_response: "类型检查通过" }],
  [200, { hook_event_name: "SubagentStop", agent_id: AG1, agent_type: G, last_assistant_message: "登录模块已重构为 async/await，类型检查通过。" }],
  [100, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "d_s1", duration_ms: 4200, tool_response: "ok" }],
  [500, { hook_event_name: "PostToolUse", agent_id: AG2, agent_type: G, tool_name: "Bash", tool_use_id: "a2t3", duration_ms: 1800, tool_response: "12 passed" }],
  [200, { hook_event_name: "SubagentStop", agent_id: AG2, agent_type: G, last_assistant_message: "新增 12 个单元测试，全部通过。" }],
  [100, { hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "d_s2", duration_ms: 5200, tool_response: "ok" }],
  [400, { hook_event_name: "Stop", last_assistant_message: "完成：登录模块重构 + 12 个测试通过 + 文档已更新。" }],
];

let demoRunning = false;
function playDemo() {
  if (demoRunning) return;
  demoRunning = true;
  let acc = 0;
  for (const [delay, ev] of DEMO) {
    acc += delay;
    setTimeout(() => {
      // 演示事件统一归到 "demo" 会话（多数剧本条目没写 session_id）
      const sid = store.ingest({ session_id: "demo", ...ev });
      broadcast(sid);
    }, acc);
  }
  setTimeout(() => {
    demoRunning = false;
  }, acc + 100);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  CC 可视化服务已启动`);
  console.log(`  ▸ 前端面板:   http://${HOST}:${PORT}/`);
  console.log(`  ▸ 事件入口:   POST http://${HOST}:${PORT}/event`);
  console.log(`  ▸ 自管会话:   ${manager.available ? "可用(claude 已找到)" : "不可用(未找到 claude CLI)"}`);
  console.log(`  ▸ 等待 Claude Code hook 事件...\n`);
});

// 退出时回收全部自管子进程
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    manager.shutdown();
    process.exit(0);
  });
}
process.on("exit", () => manager.shutdown());
