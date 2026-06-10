// F2:可视化自管会话——spawn 长驻 `claude -p` stream-json 进程,完全双向。
// 每个自管会话一个子进程;hooks 照常触发,所以办公室自动动起来;
// stdout 的 assistant/result 事件提供流式回复与忙闲状态。
// 进程死亡不丢上下文:下次发消息用 --resume <session_id> 重新拉起。
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPROVE_MCP = path.join(__dirname, "approve-mcp.mjs");

const DEFAULT_PERMISSION_MODE = "acceptEdits"; // 编辑放行,其余走前端审批卡
const PERMISSION_MODES = new Set(["default", "acceptEdits", "plan", "bypassPermissions"]);
const MODEL_RE = /^[a-z0-9.\[\]-]{1,60}$/i; // 防 argv 注入:模型名只允许安全字符
const IDLE_KILL_MS = 30 * 60 * 1000; // 空闲超 30 分钟收掉进程(resume 可恢复)
const MAX_QUEUE = 3;
const PID_FILE = path.join(os.tmpdir(), "cc-viz-managed-pids.json");

// ---- 孤儿回收:server 异常退出会留下自管 claude 子进程,启动时按 PID 文件清掉 ----
function readPids() {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, "utf8"));
  } catch {
    return [];
  }
}
function writePids(pids) {
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify(pids));
  } catch { /* ignore */ }
}
function trackPid(pid) {
  if (pid) writePids([...new Set([...readPids(), pid])]);
}
function untrackPid(pid) {
  writePids(readPids().filter((p) => p !== pid));
}
export function reapOrphans() {
  const pids = readPids();
  for (const pid of pids) {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: "ignore" });
      console.log(`[managed] 回收孤儿子进程 PID ${pid}`);
    } catch { /* 早已不在 */ }
  }
  writePids([]);
}

function resolveClaude() {
  try {
    const out = execSync("where claude", { encoding: "utf8", windowsHide: true });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // where 首行常是无扩展名的 sh 脚本,Windows 下要挑 .cmd/.exe
    return lines.find((l) => /\.(cmd|exe|bat)$/i.test(l)) || lines[0] || null;
  } catch {
    return null;
  }
}

// onEvent(kind, data):
//   "init"   {sessionId}                    进程上线拿到 session_id
//   "reply"  {sessionId, text}              assistant 文本(流式,按消息粒度)
//   "status" {sessionId, status, queued}    idle | busy | dead
export function createManager(onEvent, { port = 4317 } = {}) {
  const claudeExe = resolveClaude();
  const sessions = new Map(); // sessionId -> rec
  // rec = { sessionId, cwd, model, permissionMode, child, status: "idle"|"busy"|"dead", queue: [], buf, idleTimer }

  // 每次 spawn 重写 MCP 配置(resume 唤醒后 sessionId 可能已分叉)
  function writeMcpConfig(rec) {
    const cfg = {
      mcpServers: {
        viz: {
          command: "node",
          args: [APPROVE_MCP],
          env: { CC_VIZ_PORT: String(port), CC_VIZ_SESSION: rec.sessionId },
        },
      },
    };
    const file = path.join(os.tmpdir(), `cc-viz-mcp-${rec.sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg));
    return file;
  }

  function emitStatus(rec) {
    onEvent("status", { sessionId: rec.sessionId, status: rec.status, queued: rec.queue.length });
  }

  function armIdleTimer(rec) {
    clearTimeout(rec.idleTimer);
    rec.idleTimer = setTimeout(() => {
      if (rec.status === "idle" && rec.child) {
        rec.child.kill();
      }
    }, IDLE_KILL_MS);
  }

  function handleLine(rec, line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      // 注意:stream-json 模式下 init 要等第一条用户消息才发。
      // 正常情况 id 与 --session-id 指定的一致;resume 唤醒会分叉出新 id → 重新挂号
      if (msg.session_id !== rec.sessionId) {
        rec.sessionId = msg.session_id;
        sessions.set(rec.sessionId, rec);
        onEvent("init", { sessionId: rec.sessionId });
      }
    } else if (msg.type === "assistant") {
      const parts = msg.message?.content || [];
      const text = parts.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      if (text && rec.sessionId) onEvent("reply", { sessionId: rec.sessionId, text });
    } else if (msg.type === "result") {
      rec.status = "idle";
      armIdleTimer(rec);
      flushQueue(rec);
      emitStatus(rec);
    }
  }

  function wire(rec) {
    const child = rec.child;
    child.stdout.on("data", (chunk) => {
      rec.buf += chunk;
      let i;
      while ((i = rec.buf.indexOf("\n")) >= 0) {
        const line = rec.buf.slice(0, i).trim();
        rec.buf = rec.buf.slice(i + 1);
        if (line) handleLine(rec, line);
      }
    });
    child.stderr.on("data", (d) => {
      rec.lastErr = String(d).slice(0, 400);
    });
    child.on("exit", () => {
      untrackPid(child.pid);
      rec.child = null;
      rec.buf = "";
      clearTimeout(rec.idleTimer);
      if (rec.status !== "dead") {
        rec.status = "dead";
        if (rec.sessionId) emitStatus(rec);
      }
    });
  }

  function spawnChild(rec, resume) {
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--permission-mode", rec.permissionMode,
      "--mcp-config", writeMcpConfig(rec),
      "--permission-prompt-tool", "mcp__viz__approve", // 权限请求 → 前端审批卡
    ];
    if (rec.model) args.push("--model", rec.model);
    // 新会话用 --session-id 预先指定 UUID(不必等 init 才知道 id);唤醒用 --resume
    if (resume) args.push("--resume", rec.sessionId);
    else args.push("--session-id", rec.sessionId);
    // 安全:argv 只有固定 flag、UUID、白名单校验过的 model/mode 和临时文件路径;用户文本一律走 stdin
    rec.child = spawn(claudeExe, args, { cwd: rec.cwd, shell: true, windowsHide: true });
    rec.buf = "";
    rec.status = "idle"; // stream-json 进程起来即可收 stdin
    rec.child.stdin.on("error", () => {}); // EPIPE 等写入错误交给 exit 事件统一处理,不能炸掉 server
    rec.child.on("error", (e) => {
      rec.lastErr = String(e.message || e);
      rec.status = "dead";
      if (rec.sessionId) emitStatus(rec);
    });
    trackPid(rec.child.pid);
    wire(rec);
    armIdleTimer(rec);
  }

  function writePrompt(rec, prompt) {
    try {
      rec.child.stdin.write(JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      }) + "\n");
      rec.status = "busy";
    } catch (e) {
      rec.lastErr = String(e.message || e);
      rec.status = "dead";
      rec.queue.unshift(prompt); // 留在队首,唤醒后补发
    }
    emitStatus(rec);
  }

  function flushQueue(rec) {
    if (rec.status !== "idle" || !rec.queue.length || !rec.child) return;
    writePrompt(rec, rec.queue.shift());
  }

  // 新建自管会话:预生成 UUID + --session-id,立即返回(不等 init)
  function createSession(cwd, opts = {}) {
    if (!claudeExe) return Promise.reject(new Error("claude_not_found"));
    const permissionMode = PERMISSION_MODES.has(opts.permissionMode) ? opts.permissionMode : DEFAULT_PERMISSION_MODE;
    const model = opts.model && MODEL_RE.test(opts.model) ? opts.model : null;
    const sid = randomUUID();
    const rec = { sessionId: sid, cwd, model, permissionMode, child: null, status: "idle", queue: [], buf: "", idleTimer: null, lastErr: "" };
    sessions.set(sid, rec);
    spawnChild(rec, false);
    onEvent("init", { sessionId: sid });
    return Promise.resolve({ sessionId: sid });
  }

  // 发消息;dead 则 resume 唤醒;busy 则排队
  function sendPrompt(sessionId, prompt) {
    const rec = sessions.get(sessionId);
    if (!rec) return { ok: false, code: 404, error: "unknown_session" };
    if (!rec.child) spawnChild(rec, true); // 休眠唤醒;spawn 后即可写 stdin
    if (rec.status === "busy") {
      if (rec.queue.length >= MAX_QUEUE) return { ok: false, code: 409, error: "queue_full" };
      rec.queue.push(prompt);
      emitStatus(rec);
      return { ok: true, queued: rec.queue.length };
    }
    writePrompt(rec, prompt);
    return { ok: true, queued: 0 };
  }

  function stopSession(sessionId) {
    const rec = sessions.get(sessionId);
    if (!rec) return false;
    rec.queue.length = 0;
    if (rec.child) rec.child.kill();
    rec.status = "dead";
    emitStatus(rec);
    return true;
  }

  function shutdown() {
    for (const rec of sessions.values()) {
      try {
        rec.child?.kill();
      } catch { /* ignore */ }
    }
  }

  function info(sessionId) {
    const rec = sessions.get(sessionId);
    return rec ? { status: rec.status, queued: rec.queue.length } : null;
  }

  return { available: !!claudeExe, createSession, sendPrompt, stopSession, shutdown, info, ids: () => [...sessions.keys()] };
}
