// CC 可视化 · 前端:订阅 SSE,驱动像素办公室(office.js)与活动日志
const $ = (s) => document.querySelector(s);

const NAME = {
  main: "主控 PM",
  "general-purpose": "通用执行",
  Explore: "探索检索",
  Plan: "方案规划",
  "claude-code-guide": "CC 向导",
  "code-reviewer": "代码评审",
  "statusline-setup": "状态栏",
};
const TOOL_IC = {
  Bash: "💻", PowerShell: "💻", Read: "📖", Write: "📝", Edit: "✏️",
  NotebookEdit: "✏️", Grep: "🔎", Glob: "🗂️", WebFetch: "🌐", WebSearch: "🌐",
  Agent: "👥", Task: "👥",
};
const nameFor = (t) => NAME[t] || t || "子 agent";
const toolIcon = (n) => TOOL_IC[n] || "🔧";

function hueFor(key) {
  if (!key || key === "root") return 22; // 主控用 Claude 官方橙
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 360;
  return h;
}
const colorFor = (key) => `hsl(${hueFor(key)} 62% 55%)`;

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}
function fmtDur(ms) {
  if (ms == null) return "";
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---- 多会话缓存与楼层 ----
const cache = new Map(); // sessionId -> state
let selected = null; // 当前观察的 sessionId
let lastIndex = []; // 最近一次楼层摘要
const knownSids = new Set(); // 已见过的会话(新会话提示用)
const freshSids = new Set(); // 待查看的新会话
let managedOk = false; // server 端 claude CLI 是否可用
const mstatus = new Map(); // sessionId -> {status, queued}(自管会话进程状态)
const approvals = new Map(); // id -> {id, sessionId, toolName, summary, createdAt}(待审批)

// ---- 审批卡 ----
function renderApprovals() {
  const box = $("#approvals");
  const list = [...approvals.values()];
  box.innerHTML = list
    .map((a) => {
      const room = a.sessionId ? (a.sessionId === "demo" ? "演示" : a.sessionId.slice(0, 6)) : "?";
      return `<div class="approval-card" data-id="${esc(a.id)}">
        <div class="ac-head">⛔ 权限审批 <span class="ac-room">房间 ${esc(room)}</span></div>
        <div class="ac-body"><b>${esc(a.toolName)}</b><code>${esc(a.summary || "(无参数)")}</code></div>
        <div class="ac-actions">
          <button class="btn primary" data-act="allow">✅ 允许</button>
          <button class="btn" data-act="always">✅ 本会话总是允许 ${esc(a.toolName)}</button>
          <button class="btn deny" data-act="deny">🚫 拒绝</button>
        </div>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".approval-card button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.closest(".approval-card").dataset.id;
      const act = btn.dataset.act;
      decideApproval(id, act === "deny" ? "deny" : "allow", act === "always");
    });
  });
}

async function decideApproval(id, behavior, always) {
  approvals.delete(id); // 立即从 UI 摘掉,server 幂等
  renderApprovals();
  try {
    await fetch("/api/approval/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, behavior, always }),
    });
  } catch {
    /* server 掉线时按钮无效,卡片已移除 */
  }
}

function pickDefault(index) {
  let fallback = null;
  for (const f of index) {
    for (const s of f.sessions) {
      if (s.status === "running") return s.sessionId;
      if (!fallback) fallback = s.sessionId;
    }
  }
  return fallback;
}

function selectSession(sid) {
  if (sid === selected) return;
  selected = sid;
  freshSids.delete(sid);
  lastConvoLen = -1; // 切会话后对话面板重新滚到底
  Office.reset();
  window.Dialogue?.reset?.();
  renderFloors(lastIndex);
  render(cache.get(sid) || null);
}

function renderFloors(index) {
  lastIndex = index;
  const list = $("#floors-list");
  const total = index.reduce((n, f) => n + f.sessions.length, 0);
  $("#floors-empty").style.display = total ? "none" : "";
  $("#stat-session").textContent = total ? `${index.length} / ${total}` : "—";

  list.innerHTML = index
    .map((f, i) => {
      const fno = index.length - i; // 最新楼层在最上面、层号最大
      const rooms = f.sessions
        .map((s) => {
          const cls = [
            "room",
            s.sessionId === selected ? "sel" : "",
            freshSids.has(s.sessionId) ? "new" : "",
          ].filter(Boolean).join(" ");
          const st = s.status === "running" ? "running" : s.ended ? "ended" : s.status;
          const label = s.sessionId === "demo" ? "演示" : s.sessionId.slice(0, 6);
          return `<button class="${cls}" data-sid="${esc(s.sessionId)}" data-status="${st}"
            title="${esc(s.lastPrompt || s.sessionId)}">
            <span class="dot"></span>
            <span class="rid">${s.managed ? "💬" : ""}${esc(label)}</span>
            <span class="rmeta">🐙${s.agentCount} 🔧${s.totalTools}</span>
            ${freshSids.has(s.sessionId) ? '<span class="badge">新</span>' : ""}
          </button>`;
        })
        .join("");
      return `<div class="floor">
        <div class="floor-head" title="${esc(f.cwd)}"><b>F${fno}</b><span>${esc(clip(f.name, 12))}</span></div>
        ${rooms}
      </div>`;
    })
    .join("");

  list.querySelectorAll(".room").forEach((btn) => {
    btn.addEventListener("click", () => selectSession(btn.dataset.sid));
  });
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function handleMsg(msg) {
  if (msg.kind === "mstatus") {
    mstatus.set(msg.sessionId, { status: msg.status, queued: msg.queued });
    if (msg.sessionId === selected) updatePromptBar(cache.get(selected));
    return;
  }
  if (msg.kind === "approval") {
    approvals.set(msg.approval.id, msg.approval);
    renderApprovals();
    Office.say("root", "⛔ 有操作等你审批!", { prio: 4, ms: 6000, cls: "alert" });
    return;
  }
  if (msg.kind === "approval_done") {
    approvals.delete(msg.id);
    renderApprovals();
    return;
  }
  if (msg.kind === "hello") {
    managedOk = !!msg.managedOk;
    approvals.clear();
    for (const a of msg.approvals || []) approvals.set(a.id, a);
    renderApprovals();
    cache.clear();
    for (const [sid, st] of Object.entries(msg.states || {})) cache.set(sid, st);
    knownSids.clear();
    freshSids.clear();
    for (const sid of cache.keys()) knownSids.add(sid);
  } else if (msg.kind === "update") {
    if (msg.state) cache.set(msg.sessionId, msg.state);
    if (!knownSids.has(msg.sessionId)) {
      knownSids.add(msg.sessionId);
      if (msg.sessionId !== selected) freshSids.add(msg.sessionId);
    }
  } else {
    return;
  }
  const index = msg.index || [];
  // 被 sweep 清理的会话同步丢弃
  const live = new Set();
  for (const f of index) for (const s of f.sessions) live.add(s.sessionId);
  for (const sid of [...cache.keys()]) if (!live.has(sid)) cache.delete(sid);
  for (const sid of [...freshSids]) if (!live.has(sid)) freshSids.delete(sid);

  if (!selected || !cache.has(selected)) {
    const next = pickDefault(index);
    if (next) {
      selected = next;
      freshSids.delete(next);
      Office.reset();
      window.Dialogue?.reset?.();
    } else {
      selected = null;
      Office.reset();
    }
    renderFloors(index);
    render(selected ? cache.get(selected) : null);
    return;
  }
  renderFloors(index);
  if (msg.kind === "hello" || msg.sessionId === selected) render(cache.get(selected));
}

// ---- F2:自管会话对话条 ----
function updatePromptBar(state) {
  const bar = $("#prompt-bar");
  if (!state || !state.managed) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const ms = mstatus.get(state.sessionId);
  const st = $("#pb-status");
  if (!managedOk) st.textContent = "⚠️ 未找到 claude CLI,无法派发";
  else if (ms?.status === "dead") st.textContent = "💤 会话已休眠 · 发送将自动唤醒";
  else if (state.status === "running" || ms?.status === "busy")
    st.textContent = `🟢 运行中…${ms?.queued ? ` 队列 ${ms.queued} 条` : " 新指令将排队"}`;
  else st.textContent = "💬 驻场会话 · 可直接派发指令";
}

async function sendPrompt() {
  const input = $("#pb-input");
  const text = input.value.trim();
  if (!text || !selected) return;
  input.value = "";
  try {
    const r = await fetch("/api/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: selected, prompt: text }),
    });
    const j = await r.json();
    if (!r.ok) $("#pb-status").textContent = "⚠️ 派发失败:" + (j.error || r.status);
    else Office.say("root", "收到,马上安排!", { prio: 3, ms: 2500 });
  } catch {
    $("#pb-status").textContent = "⚠️ 网络错误";
  }
}

async function createManagedSession() {
  const cwdInput = $("#new-cwd");
  const err = $("#new-err");
  const cwd = cwdInput.value.trim() || (selected && cache.get(selected)?.cwd) || "";
  if (!cwd) {
    err.textContent = "请输入项目路径(或先选中一个会话以复用其路径)";
    return;
  }
  const btn = $("#btn-new-session");
  btn.disabled = true;
  err.textContent = "⏳ 启动中…";
  try {
    const r = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        model: $("#new-model").value || undefined,
        permissionMode: $("#new-perm").value || undefined,
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      err.textContent = "⚠️ " + (j.error || r.status);
    } else {
      err.textContent = "";
      cwdInput.value = "";
      selectSession(j.sessionId);
    }
  } catch {
    err.textContent = "⚠️ 网络错误";
  }
  btn.disabled = false;
}

// ---- 对话全文面板(驻场会话) ----
let lastConvoLen = -1;
function renderConvo(state) {
  const card = $("#convo-card");
  const entries = state?.convo || [];
  if (!state?.managed && !entries.length) {
    card.hidden = true;
    lastConvoLen = -1;
    return;
  }
  card.hidden = false;
  const box = $("#convo");
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = entries
    .map(
      (e) => `<div class="convo-item" data-role="${e.role}">
        <div class="ci-meta">${e.role === "user" ? "🧑 你" : "🤖 Claude"} · ${fmtTime(e.at)}</div>
        <div class="ci-text">${esc(e.text)}</div>
      </div>`
    )
    .join("") || `<div class="convo-empty">还没有对话,在下方输入框给经理下第一条指令吧</div>`;
  if (entries.length !== lastConvoLen && (atBottom || lastConvoLen === -1)) box.scrollTop = box.scrollHeight;
  lastConvoLen = entries.length;
}

// ---- 渲染主流程(单个会话) ----
function render(state) {
  updatePromptBar(state);
  renderConvo(state);
  if (!state) {
    $("#stat-agents").textContent = "0";
    $("#stat-tools").textContent = "0";
    $("#run-pill").dataset.status = "idle";
    $("#run-pill").querySelector(".label").textContent = "空闲";
    $("#office-path").textContent = "等待会话接入…";
    $("#prompt-body").textContent = "等待用户指令…";
    $("#prompt-body").classList.add("empty-text");
    $("#feed").innerHTML = "";
    return;
  }
  // 顶栏
  const agents = Object.values(state.agents || {});
  const subs = agents.filter((a) => a.key !== "root");
  $("#stat-agents").textContent = subs.length;
  $("#stat-tools").textContent = state.stats?.totalTools ?? 0;
  $("#office-path").textContent = state.cwd
    ? `${state.cwd} · ${String(state.sessionId).slice(0, 8)}`
    : `会话 ${String(state.sessionId).slice(0, 8)}`;

  const pill = $("#run-pill");
  pill.dataset.status = state.status;
  pill.querySelector(".label").textContent =
    state.status === "running" ? "运行中" : state.status === "done" ? "已完成" : "空闲";

  // 工具按 agent 归类
  const toolsByAgent = {};
  for (const t of state.tools || []) (toolsByAgent[t.agentKey] ||= []).push(t);

  // 像素办公室
  Office.sync(state, toolsByAgent);
  window.Dialogue?.onState(state, toolsByAgent);
  for (const a of agents) {
    const running = (toolsByAgent[a.key] || []).find((t) => t.status === "running");
    Office.setChip(a.key, running ? `${toolIcon(running.name)} ${esc(running.name)}` : null);
  }

  // 当前任务
  const pb = $("#prompt-body");
  if (state.lastPrompt) {
    pb.textContent = state.lastPrompt;
    pb.classList.remove("empty-text");
  } else {
    pb.textContent = "等待用户指令…";
    pb.classList.add("empty-text");
  }

  // 活动日志(整列重渲染,纯文本无动画,简单可靠)
  const feed = $("#feed");
  feed.innerHTML = (state.feed || [])
    .map((f) => {
      const color = f.agent ? colorFor(f.agent) : "transparent";
      return `<div class="feed-item" data-kind="${f.kind}">
        <span class="ftime">${fmtTime(f.at)}</span>
        <span class="agent-chip" style="--agent-color:${color}"></span>
        <span class="ftext">${esc(f.text)}</span>
      </div>`;
    })
    .join("");
}

// ---- SSE 连接 ----
function connect() {
  const conn = $("#conn");
  const es = new EventSource("/events");
  window.__sse = es; // 便于调试/截图时临时断开
  es.onopen = () => (conn.dataset.on = "true");
  es.onerror = () => (conn.dataset.on = "false");
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleMsg(msg);
    } catch {
      /* ignore keepalive */
    }
  };
}

// ---- 启动 ----
if (new URLSearchParams(location.search).get("debug") !== "sprites") {
  Office.mount($("#office-stage"));
  $("#btn-demo").addEventListener("click", () => fetch("/api/demo", { method: "POST" }));
  $("#btn-reset").addEventListener("click", () => fetch("/api/reset", { method: "POST" }));
  $("#btn-new-session").addEventListener("click", createManagedSession);
  $("#pb-send").addEventListener("click", sendPrompt);
  $("#pb-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
  connect();
}
