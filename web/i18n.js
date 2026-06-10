// CC 可视化 · 轻量 i18n(零依赖)
// 用法:I18N.t(key, params) 取译文;data-i18n / -ph / -title 标记静态文案,自动替换;
//      I18N.setLang(lang) 切换并触发 onChange 回调;I18N.onChange(cb) 注册重渲染。
window.I18N = (() => {
  "use strict";

  const DICT = {
    zh: {
      // —— 顶栏 ——
      "ui.title": "CC 可视化 · Agent 办公室",
      "ui.subtitle": "Claude Code 多 agent 实时协作看板",
      "ui.stat.agents": "子 agent",
      "ui.stat.tools": "工具调用",
      "ui.stat.sessions": "楼层 · 会话",
      "ui.btn.demo": "▶ 演示",
      "ui.btn.reset": "清空",
      "ui.conn": "连接",
      "ui.lang": "EN",
      // —— 状态 ——
      "ui.status.idle": "空闲",
      "ui.status.running": "运行中",
      "ui.status.done": "已完成",
      // —— 楼层 ——
      "ui.floors": "🛗 楼层",
      "ui.floors.empty": "暂无会话<br>等待 hook 接入…",
      "ui.room.demo": "演示",
      "ui.room.new": "新",
      // —— 新会话表单 ——
      "ui.new.cwd": "项目路径…",
      "ui.new.model.default": "模型:默认",
      "ui.new.perm.acceptEdits": "编辑放行+审批",
      "ui.new.perm.default": "全部审批",
      "ui.new.perm.plan": "plan 模式",
      "ui.new.perm.bypass": "⚠ bypass",
      "ui.new.btn": "➕ 新会话",
      "ui.new.btn.title": "在该路径下开一个可视化自管会话",
      "ui.new.needCwd": "请输入项目路径(或先选中一个会话以复用其路径)",
      "ui.new.starting": "⏳ 启动中…",
      // —— 办公室 ——
      "ui.office.head": "🏢 办公室实况",
      "ui.office.waiting": "等待会话接入…",
      "ui.office.session": "会话 {id}",
      "ui.hint": "🐙 章鱼员工待命中…<br>接入 Claude Code 或点右上角「▶ 演示」",
      // —— 侧栏 ——
      "ui.card.task": "📋 当前任务",
      "ui.card.convo": "💬 对话全文",
      "ui.card.feed": "⚡ 实时活动日志",
      "ui.task.waiting": "等待用户指令…",
      // —— 对话条 ——
      "ui.pb.input": "给这间办公室的经理下指令…(Enter 发送,Shift+Enter 换行)",
      "ui.pb.send": "📨 派发",
      "ui.pb.idle": "💬 驻场会话 · 可直接派发指令",
      "ui.pb.dead": "💤 会话已休眠 · 发送将自动唤醒",
      "ui.pb.noClaude": "⚠️ 未找到 claude CLI,无法派发",
      "ui.pb.running": "🟢 运行中…新指令将排队",
      "ui.pb.queued": "🟢 运行中…队列 {n} 条",
      "ui.pb.received": "收到,马上安排!",
      "ui.pb.sendFail": "⚠️ 派发失败:{err}",
      "ui.pb.netErr": "⚠️ 网络错误",
      // —— 对话面板 ——
      "ui.convo.you": "🧑 你",
      "ui.convo.claude": "🤖 Claude",
      "ui.convo.empty": "还没有对话,在下方输入框给经理下第一条指令吧",
      // —— 审批卡 ——
      "ui.appr.head": "⛔ 权限审批",
      "ui.appr.room": "房间 {room}",
      "ui.appr.noArg": "(无参数)",
      "ui.appr.allow": "✅ 允许",
      "ui.appr.always": "✅ 本会话总是允许 {tool}",
      "ui.appr.deny": "🚫 拒绝",
      "ui.appr.toast": "⛔ 有操作等你审批!",
      // —— 角色名(agent type → 显示名) ——
      "role.main": "主控 PM",
      "role.general-purpose": "通用执行",
      "role.Explore": "探索检索",
      "role.Plan": "方案规划",
      "role.claude-code-guide": "CC 向导",
      "role.code-reviewer": "代码评审",
      "role.statusline-setup": "状态栏",
      "role.fallback": "子 agent",
      // —— 活动日志(feed)——
      "feed.sessionStart": "会话开始（{arg}）",
      "feed.prompt": "用户：{arg}",
      "feed.spawn": "子 agent 上线：{arg}",
      "feed.dispatch": "派活 → {arg}",
      "feed.tool": "{tool}：{arg}",
      "feed.error": "失败：{tool}",
      "feed.subDone": "子 agent 完成：{arg}",
      "feed.stopOk": "本轮完成",
      "feed.stopFail": "会话异常结束",
      "feed.sessionEnd": "会话结束",
      "feed.reply": "{arg}",
      "feed.other": "事件：{arg}",
    },
    en: {
      "ui.title": "CC Viz · Agent Office",
      "ui.subtitle": "Live dashboard for Claude Code multi-agent teamwork",
      "ui.stat.agents": "sub-agents",
      "ui.stat.tools": "tool calls",
      "ui.stat.sessions": "floors · sessions",
      "ui.btn.demo": "▶ Demo",
      "ui.btn.reset": "Clear",
      "ui.conn": "link",
      "ui.lang": "中",
      "ui.status.idle": "Idle",
      "ui.status.running": "Running",
      "ui.status.done": "Done",
      "ui.floors": "🛗 Floors",
      "ui.floors.empty": "No sessions yet<br>waiting for hooks…",
      "ui.room.demo": "demo",
      "ui.room.new": "NEW",
      "ui.new.cwd": "project path…",
      "ui.new.model.default": "Model: default",
      "ui.new.perm.acceptEdits": "auto-edit + approve",
      "ui.new.perm.default": "approve all",
      "ui.new.perm.plan": "plan mode",
      "ui.new.perm.bypass": "⚠ bypass",
      "ui.new.btn": "➕ New session",
      "ui.new.btn.title": "Spawn a viz-managed session in this path",
      "ui.new.needCwd": "Enter a project path (or select a session to reuse its path)",
      "ui.new.starting": "⏳ starting…",
      "ui.office.head": "🏢 Office Live",
      "ui.office.waiting": "Waiting for a session…",
      "ui.office.session": "session {id}",
      "ui.hint": "🐙 Octopus staff standing by…<br>connect Claude Code or hit「▶ Demo」top-right",
      "ui.card.task": "📋 Current Task",
      "ui.card.convo": "💬 Full Conversation",
      "ui.card.feed": "⚡ Live Activity Log",
      "ui.task.waiting": "Waiting for a prompt…",
      "ui.pb.input": "Tell this office's manager what to do… (Enter to send, Shift+Enter for newline)",
      "ui.pb.send": "📨 Dispatch",
      "ui.pb.idle": "💬 Resident session · type a command below",
      "ui.pb.dead": "💤 Session asleep · sending will wake it",
      "ui.pb.noClaude": "⚠️ claude CLI not found, cannot dispatch",
      "ui.pb.running": "🟢 Running… new commands will queue",
      "ui.pb.queued": "🟢 Running… {n} queued",
      "ui.pb.received": "Got it, on it!",
      "ui.pb.sendFail": "⚠️ Dispatch failed: {err}",
      "ui.pb.netErr": "⚠️ Network error",
      "ui.convo.you": "🧑 You",
      "ui.convo.claude": "🤖 Claude",
      "ui.convo.empty": "No conversation yet. Send the manager your first command below.",
      "ui.appr.head": "⛔ Permission Request",
      "ui.appr.room": "room {room}",
      "ui.appr.noArg": "(no args)",
      "ui.appr.allow": "✅ Allow",
      "ui.appr.always": "✅ Always allow {tool} this session",
      "ui.appr.deny": "🚫 Deny",
      "ui.appr.toast": "⛔ An action needs your approval!",
      "role.main": "Lead PM",
      "role.general-purpose": "General",
      "role.Explore": "Explorer",
      "role.Plan": "Planner",
      "role.claude-code-guide": "CC Guide",
      "role.code-reviewer": "Reviewer",
      "role.statusline-setup": "Statusline",
      "role.fallback": "sub-agent",
      "feed.sessionStart": "Session started ({arg})",
      "feed.prompt": "User: {arg}",
      "feed.spawn": "Sub-agent online: {arg}",
      "feed.dispatch": "Dispatch → {arg}",
      "feed.tool": "{tool}: {arg}",
      "feed.error": "Failed: {tool}",
      "feed.subDone": "Sub-agent done: {arg}",
      "feed.stopOk": "Turn complete",
      "feed.stopFail": "Session ended abnormally",
      "feed.sessionEnd": "Session ended",
      "feed.reply": "{arg}",
      "feed.other": "Event: {arg}",
    },
  };

  const KEY = "cc-viz-lang";
  let lang = (() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch { /* ignore */ }
    return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  })();

  const listeners = new Set();

  function has(key) {
    return DICT[lang]?.[key] != null || DICT.zh[key] != null;
  }

  function t(key, params) {
    let s = DICT[lang]?.[key];
    if (s == null) s = DICT.zh[key];
    if (s == null) return key;
    if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : ""));
    return s;
  }

  // 扫描 DOM,替换 data-i18n(textContent)、-i18n-html(innerHTML)、-i18n-ph(placeholder)、-i18n-title(title)
  function apply(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll("[data-i18n-html]").forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
    root.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
    root.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  }

  function setLang(next) {
    if (next !== "zh" && next !== "en") return;
    if (next === lang) return;
    lang = next;
    try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    apply();
    for (const cb of listeners) cb(lang);
  }

  function onChange(cb) { listeners.add(cb); }

  return {
    get lang() { return lang; },
    t, has, apply, setLang, onChange,
  };
})();
