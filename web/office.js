// CC 可视化 · 2D 像素办公室场景
// 职责:场景/家具布置、章鱼 actor 生命周期、空闲漫游 FSM、rAF 动画循环、气泡/详情卡定位。
// 数据归 SSE(sync 只做 diff),位置与动画归 rAF —— 两个时钟互不打断。
window.Office = (() => {
  "use strict";
  const S = window.Sprites;
  const SC = S.SCALE; // 3
  const SCENE_W = 960;
  const WALL_H = 96;
  const SPR_W = S.W * SC, SPR_H = S.H * SC; // 48 × 54

  // ---------- 布局常量 ----------
  const MGR_DESK = { x: 90, y: 150 }; // 经理桌(26×13)
  const MGR_SEAT = { x: 129, y: 171 };
  const DESK_COLS = 4, DESK_GAP_X = 155, DESK_GAP_Y = 135;
  const DESK_X0 = 80, DESK_Y0 = 260;
  const CORRIDOR_X = 700;
  const DOOR_SPAWN = { x: 81, y: 112 };
  const MIN_DESKS = 4; // 始终摆出的空工位数

  const deskSlotPos = (i) => ({
    x: DESK_X0 + (i % DESK_COLS) * DESK_GAP_X,
    y: DESK_Y0 + Math.floor(i / DESK_COLS) * DESK_GAP_Y,
  });
  const deskSeat = (i) => {
    const p = deskSlotPos(i);
    return { x: p.x + 30, y: p.y + 21 };
  };

  // 设施:spots 是站位(脚底坐标),anim 是到位后播的动画
  const FACILITIES = [
    { id: "coffee", furn: "coffee", fx: 880, fy: 120, anim: "coffee", cap: 2, spots: [{ x: 862, y: 168, flip: false }, { x: 925, y: 174, flip: true }] },
    { id: "cooler", furn: "cooler", fx: 818, fy: 128, anim: "idle", cap: 2, spots: [{ x: 800, y: 165, flip: false }, { x: 855, y: 170, flip: true }] },
    { id: "lift", furn: "dumbbells", fx: 845, fy: 280, anim: "lift", cap: 1, spots: [{ x: 869, y: 318, flip: false }] },
    { id: "treadmill", furn: "treadmill", fx: 840, fy: 360, anim: "run", cap: 1, spots: [{ x: 873, y: 384, flip: false }] },
    { id: "sofa", furn: "sofa", fx: 480, fy: 478, anim: "sleep", cap: 2, spots: [{ x: 502, y: 494, flip: false }, { x: 530, y: 494, flip: true }], zOnSpot: true },
  ];
  const DECOR = [
    { furn: "door", x: 60, y: 32 },
    { furn: "whiteboard", x: 340, y: 26 },
    { furn: "plant", x: 745, y: 130 },
    { furn: "plant", x: 640, y: 470 },
  ];

  // 储物货架(F3):墙上 3×3 格,箱子=工作目录;agent 去拿箱子再搬回工位
  const SHELF_POS = { x: 560, y: 20 };
  const SHELF_SPOT = { x: 611, y: 150 }; // 取箱站位(脚底)
  const SHELF_CELL_X = [570, 599, 628]; // 格子内箱子左上角(场景坐标)
  const SHELF_CELL_Y = [23, 44, 65];
  const BOX_W = 24, BOX_H = 18; // 8×6 像素 × SC
  const PICK_MS = 600; // 弯腰拿箱时长
  const BOX_SWAP_COOLDOWN = 10000; // 换箱节流:目录抖动时 10s 内不再跑货架
  const shortDir = (d) => (d && d.length > 10 ? d.slice(0, 9) + "…" : d || "");

  // 漫游加权抽签 —— 原地动作(打游戏/发呆)权重高,减少满屋乱跑
  const WANDER = [
    { kind: "game", w: 32 },
    { kind: "facility", id: "coffee", w: 14 },
    { kind: "facility", id: "cooler", w: 9 },
    { kind: "facility", id: "lift", w: 7 },
    { kind: "facility", id: "treadmill", w: 7 },
    { kind: "facility", id: "sofa", w: 11 },
    { kind: "daze", w: 8 },
    { kind: "chat", w: 12 },
  ];
  // 各类停留时长(ms)
  const DUR_IDLE = [22000, 48000];   // 多久才动一次(在工位歇着)
  const DUR_GAME = [20000, 42000];   // 打游戏一局
  const DUR_DAZE = [14000, 28000];   // 发呆
  const DUR_FACILITY = [16000, 32000]; // 喝咖啡/健身/打盹
  const DUR_RETRY = [9000, 18000];   // 设施满员/无人可聊时的重试间隔

  const SPEED = 55, SPEED_RECALL = 95;
  const PRIO = { error: 4, chat: 3, done: 2, facility: 1, work: 1 };

  const rand = (a, b) => a + Math.random() * (b - a);
  const now = () => performance.now();

  // ---------- 模块状态 ----------
  let stage, scene, overlay, bgCv, hintEl, cardEl;
  let fit = 1, sceneH = 560, deskRows = 2;
  const actors = new Map(); // key -> actor
  const deskAssign = new Map(); // key -> slotIdx
  const deskEls = new Map(); // slotIdx -> {cv, variant}
  let mgrDeskEl = null;
  let shelfEl = null, shelfZ = 0;
  const shelfBoxes = new Map(); // dir -> {cv, label, x, y}
  const occupancy = new Map(); // facilityId -> Set(key)
  FACILITIES.forEach((f) => occupancy.set(f.id, new Set()));
  let firstSyncDone = false;
  let lastState = null;
  let raf = 0, lastT = 0;

  // ---------- 场景搭建 ----------
  function addCanvas(src, x, y, z) {
    const cv = document.createElement("canvas");
    cv.width = src.width; cv.height = src.height;
    cv.getContext("2d").drawImage(src, 0, 0);
    cv.className = "sprite";
    cv.style.width = src.width * SC + "px";
    cv.style.height = src.height * SC + "px";
    cv.style.transform = `translate(${x}px, ${y}px)`;
    cv.style.zIndex = z ?? Math.round(y + src.height * SC);
    scene.appendChild(cv);
    return cv;
  }

  function drawBg() {
    bgCv.width = SCENE_W; bgCv.height = sceneH;
    const c = bgCv.getContext("2d");
    // 墙
    c.fillStyle = "#ddd8ee"; c.fillRect(0, 0, SCENE_W, WALL_H);
    c.fillStyle = "#c5bfdd"; c.fillRect(0, WALL_H - 7, SCENE_W, 7);
    // 地板(木板)
    c.fillStyle = "#efe6d4"; c.fillRect(0, WALL_H, SCENE_W, sceneH - WALL_H);
    c.strokeStyle = "rgba(120,90,50,.10)"; c.lineWidth = 1;
    for (let y = WALL_H + 28; y < sceneH; y += 28) {
      c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(SCENE_W, y + 0.5); c.stroke();
      const off = ((y / 28) % 2) * 60;
      for (let x = off + 40; x < SCENE_W; x += 120) {
        c.beginPath(); c.moveTo(x + 0.5, y - 28); c.lineTo(x + 0.5, y); c.stroke();
      }
    }
    const rug = (x, y, w, h, col) => {
      c.fillStyle = col;
      c.beginPath();
      c.roundRect(x, y, w, h, 12);
      c.fill();
    };
    rug(56, 122, 220, 104, "#d6def6");   // 经理地毯
    rug(792, 100, 158, 86, "#e8dcc9");   // 茶水间
    rug(806, 264, 146, 138, "#d2d5de");  // 健身角
    rug(448, 462, 170, 64, "#e4e1f1");   // 沙发区
  }

  function deskVariantFor(working, tick) {
    return working ? (tick % 2 ? "on1" : "on0") : "off";
  }

  function ensureDesk(idx) {
    if (deskEls.has(idx)) return deskEls.get(idx);
    const rows = Math.floor(idx / DESK_COLS) + 1;
    if (rows > deskRows) { deskRows = rows; resizeScene(); }
    const p = deskSlotPos(idx);
    const src = S.getFurnitureCanvas("desk", "off");
    const cv = addCanvas(src, p.x, p.y);
    const d = { cv, variant: "off" };
    deskEls.set(idx, d);
    return d;
  }

  function setDeskVariant(d, name, variant) {
    if (d.variant === variant) return;
    d.variant = variant;
    const src = S.getFurnitureCanvas(name, variant);
    const ctx = d.cv.getContext("2d");
    ctx.clearRect(0, 0, d.cv.width, d.cv.height);
    ctx.drawImage(src, 0, 0);
  }

  function resizeScene() {
    const need = Math.max(560, DESK_Y0 + deskRows * DESK_GAP_Y + 60);
    if (need !== sceneH) { sceneH = need; drawBg(); }
    layoutFit();
  }

  function layoutFit() {
    if (!stage) return;
    fit = Math.min(stage.clientWidth / SCENE_W, 1.4);
    scene.style.transform = `scale(${fit})`;
    scene.style.height = sceneH + "px";
    stage.style.height = sceneH * fit + "px";
  }

  function mount(stageEl) {
    stage = stageEl;
    stage.innerHTML = "";
    scene = document.createElement("div");
    scene.id = "office-scene";
    overlay = document.createElement("div");
    overlay.id = "office-overlay";
    stage.append(scene, overlay);

    bgCv = document.createElement("canvas");
    bgCv.className = "bg";
    scene.appendChild(bgCv);
    drawBg();

    // 家具
    DECOR.forEach((d) => addCanvas(S.getFurnitureCanvas(d.furn), d.x, d.y));
    shelfEl = addCanvas(S.getFurnitureCanvas("shelf"), SHELF_POS.x, SHELF_POS.y);
    shelfZ = Math.round(SHELF_POS.y + shelfEl.height * SC);
    FACILITIES.forEach((f) => { f.el = addCanvas(S.getFurnitureCanvas(f.furn), f.fx, f.fy); });
    mgrDeskEl = { cv: addCanvas(S.getFurnitureCanvas("deskMgr", "off"), MGR_DESK.x, MGR_DESK.y), variant: "off" };
    for (let i = 0; i < MIN_DESKS; i++) ensureDesk(i);

    hintEl = document.createElement("div");
    hintEl.className = "office-hint";
    hintEl.innerHTML = window.I18N ? window.I18N.t("ui.hint") : "";
    overlay.appendChild(hintEl);

    // 切换语言:更新提示语 + 重贴所有名牌(角色名随语言变)
    window.I18N?.onChange(() => {
      if (hintEl) hintEl.innerHTML = window.I18N.t("ui.hint");
      for (const actor of actors.values()) {
        const span = actor.nameEl.querySelector("span");
        if (span) span.textContent = nameFor(actor.type);
      }
    });

    new ResizeObserver(layoutFit).observe(stage);
    layoutFit();

    document.addEventListener("click", (e) => {
      if (cardEl && !cardEl.contains(e.target) && !e.target.closest(".actor-cv,.actor-chip")) closeCard();
    });

    lastT = now();
    raf = requestAnimationFrame(loop);
  }

  // ---------- Actor ----------
  function freeSlot() {
    const used = new Set(deskAssign.values());
    let i = 0;
    while (used.has(i)) i++;
    return i;
  }

  function seatOf(actor) {
    return actor.key === "root" ? MGR_SEAT : deskSeat(deskAssign.get(actor.key));
  }

  function createActor(agent) {
    const key = agent.key;
    const hue = hueFor(key);
    if (key !== "root") deskAssign.set(key, freeSlot());
    if (key !== "root") ensureDesk(deskAssign.get(key));

    const el = document.createElement("div");
    el.className = "actor";
    const cv = document.createElement("canvas");
    cv.width = S.W; cv.height = S.H;
    cv.className = "actor-cv";
    el.appendChild(cv);
    el.style.setProperty("--agent-color", colorFor(key));
    scene.appendChild(el);

    // overlay:名牌 + 气泡(chip + 台词)
    const nameEl = document.createElement("div");
    nameEl.className = "actor-name";
    nameEl.innerHTML = `<i></i><span>${esc(nameFor(agent.type))}</span><em class="model"></em>`;
    nameEl.style.setProperty("--agent-color", colorFor(key));
    const bubEl = document.createElement("div");
    bubEl.className = "actor-bub";
    bubEl.innerHTML = `<div class="actor-quip"></div><div class="actor-chip"></div>`;
    overlay.append(nameEl, bubEl);

    const seat = key === "root" ? MGR_SEAT : deskSeat(deskAssign.get(key));
    const start = firstSyncDone ? DOOR_SPAWN : seat;
    const actor = {
      key, type: agent.type, hue, data: agent,
      el, cv, ctx: cv.getContext("2d"),
      nameEl, bubEl,
      quipEl: bubEl.querySelector(".actor-quip"),
      chipEl: bubEl.querySelector(".actor-chip"),
      x: start.x, y: start.y, flip: false,
      lastDom: {},
      anim: { name: "idle", idx: 0, nextAt: 0 },
      agentStatus: agent.status,
      prevStatus: agent.status,
      bub: { until: 0, prio: 0 },
      beh: { state: "SEATED_IDLE", path: null, pi: 0, until: 0, facility: null, nextWanderAt: now() + rand(...DUR_IDLE), chatPeer: null, chatLines: null, speed: SPEED, reason: "" },
    };
    actor.chipEl.addEventListener("click", (e) => { e.stopPropagation(); openCard(actor); });
    cv.addEventListener("click", (e) => { e.stopPropagation(); openCard(actor); });

    if (firstSyncDone && start !== seat) {
      walkTo(actor, seat, "seat");
    } else if (agent.status === "working") {
      seatWorking(actor);
    }
    actors.set(key, actor);
    return actor;
  }

  function removeActor(actor) {
    releaseFacility(actor);
    breakChat(actor);
    removeDeskBox(actor);
    actor.carryDir = null;
    if (actor.key !== "root") {
      const idx = deskAssign.get(actor.key);
      deskAssign.delete(actor.key);
      if (idx >= MIN_DESKS && !new Set(deskAssign.values()).has(idx)) {
        const d = deskEls.get(idx);
        if (d) { d.cv.remove(); deskEls.delete(idx); }
      }
    }
    actor.el.classList.add("fade-out");
    const els = [actor.el, actor.nameEl, actor.bubEl];
    setTimeout(() => els.forEach((e) => e.remove()), 350);
    actors.delete(actor.key);
    if (cardEl && cardEl._key === actor.key) closeCard();
  }

  // ---------- FSM ----------
  function setAnim(actor, name) {
    if (actor.anim.name !== name) actor.anim = { name, idx: 0, nextAt: 0 };
  }

  function atPoint(actor, p) {
    return Math.abs(actor.x - p.x) < 2 && Math.abs(actor.y - p.y) < 2;
  }

  function aisleYs() {
    const ys = [232];
    for (let k = 1; k <= deskRows; k++) ys.push(DESK_Y0 + k * DESK_GAP_Y - 28);
    return ys;
  }
  const nearestAisle = (y) => {
    const ys = aisleYs();
    let best = ys[0];
    for (const a of ys) if (Math.abs(a - y) < Math.abs(best - y)) best = a;
    return best;
  };

  function route(from, to) {
    const pts = [];
    if (Math.abs(from.y - to.y) < 10) {
      pts.push({ x: to.x, y: from.y });
    } else {
      const a1 = nearestAisle(from.y), a2 = nearestAisle(to.y);
      if (a1 === a2) {
        pts.push({ x: from.x, y: a1 }, { x: to.x, y: a1 });
      } else {
        pts.push({ x: from.x, y: a1 }, { x: CORRIDOR_X, y: a1 }, { x: CORRIDOR_X, y: a2 }, { x: to.x, y: a2 });
      }
    }
    pts.push({ x: to.x, y: to.y });
    return pts;
  }

  function walkTo(actor, target, then, reason) {
    const b = actor.beh;
    b.state = "WALKING";
    b.path = route(actor, target);
    b.pi = 0;
    b.then = then; // "seat" | "facility" | "chat"
    b.reason = reason || "";
    b.speed = reason === "recall" ? SPEED_RECALL : SPEED;
    setAnim(actor, reason === "recall" ? "run" : "walk");
  }

  function seatWorking(actor) {
    const s = seatOf(actor);
    actor.x = s.x; actor.y = s.y;
    actor.flip = false;
    actor.beh.state = "SEATED_WORKING";
    setAnim(actor, "type");
  }

  function seatIdle(actor) {
    const s = seatOf(actor);
    actor.x = s.x; actor.y = s.y;
    actor.flip = false;
    actor.beh.state = "SEATED_IDLE";
    actor.beh.nextWanderAt = now() + rand(...DUR_IDLE);
    setAnim(actor, "idle");
  }

  function releaseFacility(actor) {
    if (actor.beh.facility) {
      occupancy.get(actor.beh.facility)?.delete(actor.key);
      actor.beh.facility = null;
      actor.zOverride = null;
    }
  }

  function breakChat(actor) {
    const peer = actor.beh.chatPeer && actors.get(actor.beh.chatPeer);
    actor.beh.chatPeer = null;
    actor.beh.chatLines = null;
    if (peer) {
      peer.beh.chatPeer = null;
      peer.beh.chatLines = null;
      if (peer.beh.state === "CHATTING") {
        if (peer.agentStatus === "working") recall(peer);
        else walkTo(peer, seatOf(peer), "seat");
      }
    }
  }

  // ---------- 箱子(F3) ----------
  function deskBoxPos(actor) {
    if (actor.key === "root") return { x: MGR_DESK.x - 18, y: MGR_DESK.y + 22 };
    const p = deskSlotPos(deskAssign.get(actor.key));
    return { x: p.x - 18, y: p.y + 22 };
  }

  function removeDeskBox(actor) {
    if (!actor.deskBox) return;
    actor.deskBox.cv.remove();
    actor.deskBox.label.remove();
    actor.deskBox = null;
  }

  function placeDeskBox(actor) {
    removeDeskBox(actor);
    if (!actor.carryDir) return;
    const pos = deskBoxPos(actor);
    const cv = addCanvas(S.getFurnitureCanvas("box"), pos.x, pos.y);
    const label = document.createElement("div");
    label.className = "box-label";
    label.textContent = shortDir(actor.carryDir);
    overlay.appendChild(label);
    label.style.transform = `translate(${(pos.x + BOX_W / 2) * fit}px, ${(pos.y + BOX_H + 1) * fit}px) translateX(-50%)`;
    actor.deskBox = { cv, label };
  }

  // 货架格子:按 state.dirs 出现频次取前 9 个;被搬走的箱子在架上变虚
  function syncBoxes(state) {
    const dirs = Object.values(state?.dirs || {})
      .sort((a, b) => b.count - a.count)
      .slice(0, 9);
    const want = new Set(dirs.map((d) => d.dir));
    for (const [dir, el] of [...shelfBoxes]) {
      if (!want.has(dir)) { el.cv.remove(); el.label.remove(); shelfBoxes.delete(dir); }
    }
    const carried = new Set();
    for (const a of actors.values()) if (a.carryDir) carried.add(a.carryDir);
    dirs.forEach((d, i) => {
      const x = SHELF_CELL_X[i % 3], y = SHELF_CELL_Y[Math.floor(i / 3)];
      let el = shelfBoxes.get(d.dir);
      if (!el) {
        const cv = addCanvas(S.getFurnitureCanvas("box"), x, y, shelfZ + 1);
        const label = document.createElement("div");
        label.className = "box-label";
        overlay.appendChild(label);
        el = { cv, label, x: null, y: null };
        shelfBoxes.set(d.dir, el);
      }
      if (el.x !== x || el.y !== y) {
        el.cv.style.transform = `translate(${x}px, ${y}px)`;
        el.label.style.transform = `translate(${(x + BOX_W / 2) * fit}px, ${(y + 4) * fit}px) translateX(-50%)`;
        el.x = x; el.y = y;
      }
      el.label.textContent = d.label;
      el.cv.style.opacity = carried.has(d.dir) ? ".25" : "1";
    });
  }

  // 该去拿新箱子吗(工作目录变了且过了节流期)
  function needsBox(actor, t) {
    const dir = actor.data?.currentDir;
    return dir && actor.carryDir !== dir && t > (actor.nextBoxAt || 0);
  }

  function goFetchBox(actor, t) {
    actor.nextBoxAt = t + BOX_SWAP_COOLDOWN;
    actor.pendingDir = actor.data.currentDir;
    if (actor.carryDir) { removeDeskBox(actor); actor.carryDir = null; } // 旧箱直接归架(简化:不跑两趟)
    syncBoxes(lastState);
    say(actor.key, "📦", { prio: PRIO.work, ms: 900 });
    walkTo(actor, SHELF_SPOT, "shelf", "recall");
  }

  function recall(actor) {
    releaseFacility(actor);
    breakChat(actor);
    if (needsBox(actor, now())) { goFetchBox(actor, now()); return; }
    const s = seatOf(actor);
    if (atPoint(actor, s)) { seatWorking(actor); return; }
    say(actor.key, "❗", { prio: PRIO.done, ms: 900, cls: "alert" });
    walkTo(actor, s, "seat", "recall");
  }

  function pickWander(actor) {
    const total = WANDER.reduce((s, w) => s + w.w, 0);
    let r = Math.random() * total;
    let pick = WANDER[0];
    for (const w of WANDER) { r -= w.w; if (r <= 0) { pick = w; break; } }

    if (pick.kind === "game") {
      // 原地坐工位打游戏(不离座)
      actor.beh.state = "SEATED_GAMING";
      actor.beh.until = now() + rand(...DUR_GAME);
      actor.flip = false;
      setAnim(actor, "game");
      window.Dialogue?.onFacility?.(actor.key, "game");
      return;
    }
    if (pick.kind === "daze") {
      actor.beh.nextWanderAt = now() + rand(...DUR_DAZE);
      return;
    }
    if (pick.kind === "chat") {
      const peer = [...actors.values()].find(
        (p) => p !== actor && p.beh.state === "SEATED_IDLE" && !p.beh.chatPeer && p.agentStatus !== "working"
      );
      if (!peer) { actor.beh.nextWanderAt = now() + rand(...DUR_RETRY); return; }
      actor.beh.chatPeer = peer.key;
      peer.beh.chatPeer = actor.key;
      peer.beh.state = "CHATTING";
      peer.beh.until = 0; // 清掉残留计时,聊天的结束由发起方控制
      setAnim(peer, "idle");
      const ps = seatOf(peer);
      const spot = { x: ps.x + 42, y: ps.y + 14 };
      walkTo(actor, spot, "chat");
      return;
    }
    // facility
    const f = FACILITIES.find((x) => x.id === pick.id);
    const occ = occupancy.get(f.id);
    if (occ.size >= f.cap) { actor.beh.nextWanderAt = now() + rand(...DUR_RETRY); return; }
    const spot = f.spots[occ.size % f.spots.length];
    occ.add(actor.key);
    actor.beh.facility = f.id;
    actor.beh.spot = spot;
    walkTo(actor, spot, "facility");
  }

  function arriveAt(actor) {
    const b = actor.beh;
    if (b.then === "seat") {
      if (actor.agentStatus === "working") seatWorking(actor);
      else seatIdle(actor);
      if (actor.carryDir) placeDeskBox(actor);
    } else if (b.then === "shelf") {
      b.state = "PICKING";
      b.until = now() + PICK_MS;
      actor.flip = false;
      setAnim(actor, "idle");
    } else if (b.then === "shelfReturn") {
      actor.carryDir = null;
      syncBoxes(lastState); // 箱子回架,透明度恢复
      walkTo(actor, seatOf(actor), "seat");
    } else if (b.then === "facility") {
      const f = FACILITIES.find((x) => x.id === b.facility);
      if (!f) { seatIdle(actor); return; }
      b.state = "AT_FACILITY";
      b.until = now() + rand(...DUR_FACILITY);
      actor.flip = !!b.spot.flip;
      if (f.zOnSpot) actor.zOverride = Math.round(f.fy + f.el.height * SC) + 1;
      setAnim(actor, f.anim);
      window.Dialogue?.onFacility?.(actor.key, f.id);
    } else if (b.then === "chat") {
      b.state = "CHATTING";
      const peer = actors.get(b.chatPeer);
      if (!peer) { walkTo(actor, seatOf(actor), "seat"); return; }
      actor.flip = peer.x < actor.x;
      peer.flip = actor.x < peer.x;
      setAnim(actor, "idle");
      b.until = now() + 12000;
      window.Dialogue?.startChat?.(actor.key, peer.key);
    }
  }

  function think(actor, t) {
    const b = actor.beh;
    const working = actor.agentStatus === "working";

    // 派活打断一切(取箱流程 PICKING / recall 行走除外)
    if (working && b.state !== "SEATED_WORKING" && b.state !== "PICKING" && !(b.state === "WALKING" && b.reason === "recall")) {
      recall(actor);
      return;
    }

    switch (b.state) {
      case "SEATED_WORKING":
        if (working && needsBox(actor, t)) {
          goFetchBox(actor, t);
          break;
        }
        if (!working) {
          if (actor.justDone) {
            actor.justDone = false;
            setAnim(actor, "celebrate");
            b.state = "CELEBRATING";
            b.until = t + 1800;
          } else {
            seatIdle(actor);
          }
        }
        break;
      case "CELEBRATING":
        if (t > b.until) {
          if (actor.carryDir) {
            // 完工还箱:头顶搬着走到货架放下,再回座
            removeDeskBox(actor);
            walkTo(actor, SHELF_SPOT, "shelfReturn");
            setAnim(actor, "carry");
          } else {
            seatIdle(actor);
          }
        }
        break;
      case "PICKING":
        if (t > b.until) {
          actor.carryDir = actor.pendingDir || actor.carryDir;
          actor.pendingDir = null;
          syncBoxes(lastState); // 架上对应箱子变虚
          walkTo(actor, seatOf(actor), "seat", "recall");
          setAnim(actor, "carry");
        }
        break;
      case "SEATED_IDLE":
        if (actor.justDone) {
          actor.justDone = false;
          setAnim(actor, "celebrate");
          b.state = "CELEBRATING";
          b.until = t + 1800;
          break;
        }
        if (t > b.nextWanderAt) pickWander(actor);
        break;
      case "SEATED_GAMING":
        if (t > b.until) seatIdle(actor);
        break;
      case "WALKING":
        // 位置推进在 move() 中
        break;
      case "AT_FACILITY":
        if (t > b.until) {
          releaseFacility(actor);
          walkTo(actor, seatOf(actor), "seat");
        }
        break;
      case "CHATTING":
        if (t > b.until && b.until) {
          const peer = actors.get(b.chatPeer);
          breakChat(actor);
          walkTo(actor, seatOf(actor), "seat");
          if (peer && peer.beh.state === "CHATTING") seatIdle(peer);
        }
        break;
    }
  }

  function move(actor, dt) {
    const b = actor.beh;
    if (b.state !== "WALKING" || !b.path) return;
    let remain = b.speed * dt;
    while (remain > 0 && b.pi < b.path.length) {
      const p = b.path[b.pi];
      const dx = p.x - actor.x, dy = p.y - actor.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.5) { b.pi++; continue; }
      const step = Math.min(dist, remain);
      actor.x += (dx / dist) * step;
      actor.y += (dy / dist) * step;
      if (Math.abs(dx) > 1) actor.flip = dx < 0;
      remain -= step;
    }
    if (b.pi >= b.path.length) {
      b.path = null;
      arriveAt(actor);
    }
  }

  function tickAnim(actor, t) {
    const a = S.ANIMS[actor.anim.name];
    if (t >= actor.anim.nextAt) {
      actor.anim.idx = (actor.anim.idx + 1) % a.frames;
      actor.anim.nextAt = t + 1000 / a.fps;
      actor.ctx.clearRect(0, 0, S.W, S.H);
      actor.ctx.drawImage(S.getFrameCanvas(actor.anim.name, actor.anim.idx, actor.hue), 0, 0);
    }
  }

  function writeDom(actor) {
    const x = Math.round(actor.x - SPR_W / 2);
    const y = Math.round(actor.y - SPR_H);
    const z = actor.zOverride ?? Math.round(actor.y);
    const flip = actor.flip ? -1 : 1;
    const L = actor.lastDom;
    if (L.x !== x || L.y !== y || L.flip !== flip) {
      actor.el.style.transform = `translate(${x}px, ${y}px)`;
      actor.cv.style.transform = flip === -1 ? "scaleX(-1)" : "";
      L.x = x; L.y = y; L.flip = flip;
    }
    if (L.z !== z) { actor.el.style.zIndex = z; L.z = z; }

    // overlay 元素(屏幕坐标 = 场景坐标 × fit)
    const sx = actor.x * fit;
    const headY = (actor.y - SPR_H) * fit;
    const footY = actor.y * fit;
    if (L.sx !== sx || L.headY !== headY) {
      actor.nameEl.style.transform = `translate(${sx}px, ${footY + 2}px) translateX(-50%)`;
      actor.bubEl.style.transform = `translate(${sx}px, ${headY - 4}px) translate(-50%, -100%)`;
      L.sx = sx; L.headY = headY;
    }
    if (actor.bub.until && now() > actor.bub.until) {
      actor.quipEl.classList.remove("show");
      actor.bub.until = 0; actor.bub.prio = 0;
    }
  }

  // ---------- 主循环 ----------
  function loop() {
    raf = requestAnimationFrame(loop);
    const t = now();
    let dt = (t - lastT) / 1000;
    lastT = t;
    if (document.hidden) return;
    if (dt > 0.1) dt = 0.1; // 切回标签页不补帧

    let tick400 = Math.floor(t / 400);
    for (const actor of actors.values()) {
      think(actor, t);
      move(actor, dt);
      tickAnim(actor, t);
      writeDom(actor);
    }
    // 工位屏幕亮灭/闪烁
    for (const [key, idx] of deskAssign) {
      const a = actors.get(key);
      const d = deskEls.get(idx);
      if (a && d) setDeskVariant(d, "desk", deskVariantFor(a.agentStatus === "working", tick400));
    }
    const root = actors.get("root");
    if (root && mgrDeskEl) setDeskVariant(mgrDeskEl, "deskMgr", deskVariantFor(root.agentStatus === "working", tick400));
    if (cardEl) positionCard();
  }

  // ---------- 同步(SSE → diff) ----------
  function sync(state, toolsByAgent) {
    lastState = state;
    const agents = Object.values(state.agents || {});
    const live = new Set(agents.map((a) => a.key));
    for (const a of agents) {
      let actor = actors.get(a.key);
      if (!actor) actor = createActor(a);
      actor.data = a;
      actor.tools = toolsByAgent[a.key] || [];
      if (actor.lastModel !== (a.model || "")) {
        actor.lastModel = a.model || "";
        const m = actor.nameEl.querySelector(".model");
        m.textContent = actor.lastModel;
        m.dataset.fam = actor.lastModel.split("-")[0];
      }
      if (actor.agentStatus !== a.status) {
        if (a.status === "done") actor.justDone = true;
        actor.agentStatus = a.status;
      }
      actor.el.classList.toggle("working", a.status === "working");
    }
    for (const [key, actor] of actors) {
      if (!live.has(key)) removeActor(actor);
    }
    syncBoxes(state);
    hintEl.style.display = actors.size ? "none" : "";
    if (!firstSyncDone) firstSyncDone = true;
    if (cardEl) fillCard();
  }

  // ---------- 气泡 ----------
  function say(key, text, opts = {}) {
    const actor = actors.get(key);
    if (!actor) return false;
    const prio = opts.prio ?? 1;
    const t = now();
    if (actor.bub.until > t && actor.bub.prio > prio) return false; // 高优先级占位中
    actor.quipEl.textContent = text;
    actor.quipEl.className = "actor-quip show" + (opts.cls ? " " + opts.cls : "");
    actor.bub.until = t + (opts.ms ?? 4200);
    actor.bub.prio = prio;
    return true;
  }

  function setChip(key, html) {
    const actor = actors.get(key);
    if (!actor) return;
    if (html) {
      actor.chipEl.innerHTML = html;
      actor.chipEl.classList.add("show");
    } else {
      actor.chipEl.classList.remove("show");
    }
  }

  // ---------- 详情卡 ----------
  function openCard(actor) {
    closeCard();
    cardEl = document.createElement("div");
    cardEl.className = "actor-card";
    cardEl._key = actor.key;
    overlay.appendChild(cardEl);
    fillCard();
    positionCard();
  }
  function fillCard() {
    if (!cardEl) return;
    const actor = actors.get(cardEl._key);
    if (!actor) { closeCard(); return; }
    const a = actor.data;
    const running = (actor.tools || []).find((t) => t.status === "running");
    const last = (actor.tools || []).slice(-1)[0];
    const stLabel = a.status === "working" ? "🟢 工作中" : a.status === "done" ? "🔵 已完成" : "⚪ 待命";
    let toolLine = "";
    if (running) toolLine = `<div class="row live">⚙️ 正在 <b>${esc(running.name)}</b> <code>${esc(running.input)}</code></div>`;
    else if (last) toolLine = `<div class="row">🔧 上次 ${esc(last.name)} <code>${esc(last.input)}</code> · ${fmtDur(last.durationMs)}</div>`;
    cardEl.innerHTML = `
      <button class="x">✕</button>
      <div class="hd"><i style="background:${colorFor(actor.key)}"></i><b>${esc(nameFor(a.type))}</b><span class="tag">${esc(a.type)}</span></div>
      <div class="kid">${actor.key === "root" ? "根 · 主控" : esc(actor.key)}</div>
      ${toolLine}
      <div class="row">${stLabel} · 🔧 工具 <b>${a.toolCount}</b>${a.spawnCount ? ` · 👥 派活 <b>${a.spawnCount}</b>` : ""}</div>
      ${a.lastMessage ? `<div class="row msg">💬 ${esc(a.lastMessage)}</div>` : ""}`;
    cardEl.querySelector(".x").addEventListener("click", closeCard);
  }
  function positionCard() {
    const actor = actors.get(cardEl._key);
    if (!actor) return;
    const sx = actor.x * fit, sy = (actor.y - SPR_H) * fit;
    const w = cardEl.offsetWidth || 240;
    const x = Math.max(8, Math.min(sx - w / 2, stage.clientWidth - w - 8));
    cardEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(Math.max(8, sy - cardEl.offsetHeight - 14))}px)`;
  }
  function closeCard() {
    if (cardEl) { cardEl.remove(); cardEl = null; }
  }

  // 给 dialogue 的查询接口
  function actorInfo(key) {
    const a = actors.get(key);
    if (!a) return null;
    return { key: a.key, type: a.type, state: a.beh.state, status: a.agentStatus, tools: a.tools || [], data: a.data };
  }
  const actorKeys = () => [...actors.keys()];

  // 调试:暂停/恢复动画循环(供截图等工具使用)
  function pause() { cancelAnimationFrame(raf); raf = 0; }
  function resume() { if (!raf) { lastT = now(); raf = requestAnimationFrame(loop); } }

  // 切换会话:清空所有 actor 与动态家具,回到初始空办公室
  function reset() {
    for (const actor of [...actors.values()]) {
      releaseFacility(actor);
      removeDeskBox(actor);
      actor.beh.chatPeer = null;
      actor.el.remove();
      actor.nameEl.remove();
      actor.bubEl.remove();
    }
    actors.clear();
    for (const el of shelfBoxes.values()) { el.cv.remove(); el.label.remove(); }
    shelfBoxes.clear();
    deskAssign.clear();
    for (const s of occupancy.values()) s.clear();
    for (const [idx, d] of [...deskEls]) {
      if (idx >= MIN_DESKS) { d.cv.remove(); deskEls.delete(idx); }
      else setDeskVariant(d, "desk", "off");
    }
    if (mgrDeskEl) setDeskVariant(mgrDeskEl, "deskMgr", "off");
    deskRows = 2;
    resizeScene();
    closeCard();
    firstSyncDone = false; // 切换后人物直接坐在位置上,不走进门动画
    lastState = null;
    if (hintEl) hintEl.style.display = "";
  }

  return { mount, sync, say, setChip, actorInfo, actorKeys, pause, resume, reset };
})();
