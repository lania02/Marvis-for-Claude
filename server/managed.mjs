// F2:可视化自管会话——spawn 长驻 `claude -p` stream-json 进程,完全双向。
// 每个自管会话一个子进程;hooks 照常触发,所以办公室自动动起来;
// stdout 的 assistant/result 事件提供流式回复与忙闲状态。
// 进程死亡不丢上下文:下次发消息用 --resume <session_id> 重新拉起。
import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const PERMISSION_MODE = "acceptEdits"; // headless 无法答权限弹窗;按需改 bypassPermissions
const IDLE_KILL_MS = 30 * 60 * 1000; // 空闲超 30 分钟收掉进程(resume 可恢复)
const MAX_QUEUE = 3;

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
export function createManager(onEvent) {
  const claudeExe = resolveClaude();
  const sessions = new Map(); // sessionId -> rec
  // rec = { sessionId, cwd, child, status: "starting"|"idle"|"busy"|"dead", queue: [], buf, idleTimer }

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
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", PERMISSION_MODE];
    // 新会话用 --session-id 预先指定 UUID(不必等 init 才知道 id);唤醒用 --resume
    if (resume) args.push("--resume", rec.sessionId);
    else args.push("--session-id", rec.sessionId);
    // 安全:argv 只有固定 flag 和 UUID;用户文本一律走 stdin
    rec.child = spawn(claudeExe, args, { cwd: rec.cwd, shell: true, windowsHide: true });
    rec.buf = "";
    rec.status = "idle"; // stream-json 进程起来即可收 stdin
    wire(rec);
    armIdleTimer(rec);
  }

  function writePrompt(rec, prompt) {
    rec.status = "busy";
    rec.child.stdin.write(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n");
    emitStatus(rec);
  }

  function flushQueue(rec) {
    if (rec.status !== "idle" || !rec.queue.length || !rec.child) return;
    writePrompt(rec, rec.queue.shift());
  }

  // 新建自管会话:预生成 UUID + --session-id,立即返回(不等 init)
  function createSession(cwd) {
    if (!claudeExe) return Promise.reject(new Error("claude_not_found"));
    const sid = randomUUID();
    const rec = { sessionId: sid, cwd, child: null, status: "idle", queue: [], buf: "", idleTimer: null, lastErr: "" };
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
