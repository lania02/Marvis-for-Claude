// CC 可视化 · 彩蛋对话系统
// 台词库 + 真实数据混合:模板占位符 {tool}{file}{dur}{cmd}{n}{err}{msg}{bn} 从快照填充。
// 触发:工作吐槽(私有计时器)、报错即时、完成庆祝、设施台词、成对闲聊。
window.Dialogue = (() => {
  "use strict";

  // ---------- 台词库 ----------
  const WORK_BY_TOOL = {
    Bash: [
      "又让我跑命令,我可是章鱼,不是壳。",
      "`{cmd}`…保佑别报错。",
      "命令行一响,黄金万两。",
      "这条命令跑了 {dur},够我泡杯咖啡了。",
    ],
    PowerShell: [
      "PowerShell,蓝色的大海,很合我胃口。",
      "`{cmd}`…保佑别报错。",
    ],
    Read: [
      "{file} 居然这么长,谁写的?",
      "八条触手一起翻页,速读模式启动。",
      "看文件不算摸鱼,这叫调研。",
      "又是 {file},今天第 {n} 次见它了。",
    ],
    Write: [
      "落笔如有神,写盘如有 bug。",
      "正在产出 {file},艺术品预定。",
    ],
    Edit: [
      "小心翼翼改一行…保佑别把别处改崩。",
      "这个变量名起得真有灵性。",
      "外科手术式修改 {file} 中。",
    ],
    Grep: [
      "大海捞针中,针在哪呢…",
      "grep 一下,世界清晰了。",
    ],
    Glob: ["满世界找文件,翻了 {n} 次了。"],
    WebFetch: ["上网冲浪,纯属工作需要。"],
    WebSearch: ["搜一下,别问,问就是在查资料。"],
    Agent: ["派活咯,我也是有手下的章鱼了。"],
    Task: ["派活咯,我也是有手下的章鱼了。"],
  };
  const WORK_GENERIC = [
    "这代码谁写的…哦,是我自己。",
    "再跑一次,这次一定行。",
    "咖啡因存量不足,效率 -10%。",
    "{tool} 第 {n} 连击!",
    "好想去健身角摸鱼…不行,专业点。",
    "context 又要满了,省着点用。",
    "触手都敲热了。",
  ];
  const ERROR_QUIPS = [
    "💥 {tool} 翻车了:{err}",
    "不慌,报错只是程序在跟我聊天:{err}",
    "谁动了我的环境!{tool} 挂了…",
    "💥 红了红了…{err}",
  ];
  const DONE_QUIPS = [
    "收工!干得漂亮。",
    "任务完成,申请去喝杯咖啡!",
    "终于搞定,触手都酸了。",
    "汇报老板:{msg}",
  ];
  const FACILITY_QUIPS = {
    coffee: ["续命水来咯~", "这杯敬 deadline。", "咖啡机才是本办公室的核心服务。"],
    cooler: ["饮水机旁才是情报中心。", "咕咚咕咚…满血复活。"],
    lift: ["练!八条触手八块腹肌。", "举的不是铁,是 KPI。"],
    treadmill: ["跑步时 idea 最多了。", "逃离 bug,从字面意义上。"],
    sofa: ["就眯五分钟…💤", "缓存清理中,勿扰。"],
    game: ["趁没任务,偷偷打一局。", "🎮 这把稳了…啊,翻盘了。", "摸鱼是为了更好地搬砖。", "再来最后一局,真的最后一局。"],
  };
  // 成对闲聊:奇数句是发起者,偶数句是对方
  const CHAT_PAIRS = [
    ["听说你刚调了 {bn} 次工具?", "可不,触手都快冒烟了。"],
    ["老板今天派活有点猛啊。", "嘘…他在工位上看着呢。"],
    ["你那边 context 还够吗?", "省着用呢,不行就 compact。"],
    ["中午吃什么?", "吃 token。", "…有道理。"],
    ["这次任务难吗?", "还行,就是文件有点多。", "懂,grep 到眼花。"],
    ["新来的同事怎么样?", "敲键盘比我快,有点慌。"],
    ["你说我们算不算并行执行?", "算,带薪并行。"],
  ];

  // ---------- 工具 ----------
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const trunc = (s, n) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  };
  const baseName = (input) => {
    const m = String(input ?? "").replace(/["'`]/g, "").match(/[^\\/\s:]+\.\w{1,8}/g);
    return m ? m[m.length - 1] : null;
  };

  function ctxFor(info, tool) {
    const ctx = {};
    if (tool) {
      ctx.tool = tool.name;
      ctx.cmd = trunc(tool.input, 18);
      const f = baseName(tool.input);
      if (f) ctx.file = f;
      if (tool.durationMs != null) ctx.dur = fmtDur(tool.durationMs);
      if (tool.status === "error") ctx.err = trunc(tool.response || "未知错误", 36);
    }
    if (info?.data) {
      ctx.n = info.data.toolCount;
      if (info.data.lastMessage) ctx.msg = trunc(info.data.lastMessage, 30);
    }
    return ctx;
  }

  // 只选 ctx 能填满的模板
  function compose(pool, ctx) {
    const ok = pool.filter((tpl) => {
      const need = tpl.match(/\{(\w+)\}/g) || [];
      return need.every((k) => ctx[k.slice(1, -1)] != null && ctx[k.slice(1, -1)] !== "");
    });
    if (!ok.length) return null;
    return pick(ok).replace(/\{(\w+)\}/g, (_, k) => ctx[k]);
  }

  // ---------- 工作吐槽调度 ----------
  const nextQuipAt = new Map(); // key -> ts
  setInterval(() => {
    const O = window.Office;
    if (!O) return;
    const t = performance.now();
    for (const key of O.actorKeys()) {
      const info = O.actorInfo(key);
      if (!info || info.status !== "working" || info.state !== "SEATED_WORKING") {
        nextQuipAt.delete(key);
        continue;
      }
      if (!nextQuipAt.has(key)) {
        nextQuipAt.set(key, t + rand(6000, 20000));
        continue;
      }
      if (t < nextQuipAt.get(key)) continue;
      nextQuipAt.set(key, t + rand(15000, 45000));
      const tool = info.tools.find((x) => x.status === "running") || info.tools[info.tools.length - 1];
      const ctx = ctxFor(info, tool);
      const pool = [...(tool && WORK_BY_TOOL[tool.name] || []), ...WORK_GENERIC];
      const text = compose(pool, ctx) || compose(WORK_GENERIC, ctx);
      if (text) O.say(key, text, { prio: 1, ms: 4500 });
    }
  }, 2500);

  // ---------- SSE 状态 diff:报错 / 完成 ----------
  const seenToolIds = new Set();
  const prevStatus = new Map();
  let primed = false;

  function onState(state, toolsByAgent) {
    const O = window.Office;
    const tools = state.tools || [];
    // 报错吐槽(首次快照只登记不播,避免刷屏)
    for (const tl of tools) {
      if (tl.status !== "error") continue;
      const id = tl.id || `${tl.agentKey}:${tl.name}:${tl.startedAt}`;
      if (seenToolIds.has(id)) continue;
      seenToolIds.add(id);
      if (!primed) continue;
      const info = O.actorInfo(tl.agentKey);
      const text = compose(ERROR_QUIPS, ctxFor(info, tl));
      if (text) O.say(tl.agentKey, text, { prio: 4, ms: 5500, cls: "err" });
    }
    if (seenToolIds.size > 600) {
      const keep = [...seenToolIds].slice(-300);
      seenToolIds.clear();
      keep.forEach((k) => seenToolIds.add(k));
    }
    // 完成台词
    for (const a of Object.values(state.agents || {})) {
      const prev = prevStatus.get(a.key);
      prevStatus.set(a.key, a.status);
      if (primed && prev && prev !== "done" && a.status === "done") {
        const info = O.actorInfo(a.key);
        const text = compose(DONE_QUIPS, ctxFor(info, null));
        if (text) O.say(a.key, text, { prio: 2, ms: 4500, cls: "ok" });
      }
    }
    for (const k of [...prevStatus.keys()]) {
      if (!(state.agents || {})[k]) prevStatus.delete(k);
    }
    primed = true;
  }

  // ---------- 设施台词 ----------
  function onFacility(key, facilityId) {
    if (Math.random() > 0.5) return;
    const text = pick(FACILITY_QUIPS[facilityId] || []);
    if (text) window.Office.say(key, text, { prio: 1, ms: 3800 });
  }

  // ---------- 成对闲聊 ----------
  function startChat(aKey, bKey) {
    const O = window.Office;
    const bInfo = O.actorInfo(bKey);
    const ctx = { bn: bInfo?.data?.toolCount ?? 0 };
    const script = pick(CHAT_PAIRS);
    script.forEach((line, i) => {
      setTimeout(() => {
        const a = O.actorInfo(aKey), b = O.actorInfo(bKey);
        if (!a || !b || a.state !== "CHATTING" || b.state !== "CHATTING") return; // 任一方被打断就闭嘴
        const who = i % 2 === 0 ? aKey : bKey;
        const text = line.replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? "");
        O.say(who, text, { prio: 3, ms: 3400 });
      }, 600 + i * 2000);
    });
  }

  // 切换会话:清掉跨会话残留(计时器登记、已见工具、状态 diff 基线)
  function reset() {
    nextQuipAt.clear();
    seenToolIds.clear();
    prevStatus.clear();
    primed = false; // 切换后的首个快照只登记不播,避免补播旧台词
  }

  return { onState, onFacility, startChat, reset };
})();
