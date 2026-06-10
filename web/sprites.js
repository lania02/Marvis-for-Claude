// CC 可视化 · 像素 sprite 系统
// 章鱼 = 字符串像素矩阵(一字符一像素),运行时按 agent 色相生成调色板,离屏 canvas 缓存。
// 字符含义: . 透明  P 身体  D 暗部  H 高光  W 眼白  K 黑(瞳孔/线条)  B 腮红
//           m 米白  c 咖啡  s 浅雾(蒸汽/汗)  g 浅金属  G 深金属  y 黄  r 红  R 暗红
//           w 木  v 深木  l 浅木  e 绿  E 深绿  n 蓝  o 橙(Claude)  S 屏背  O 屏沿(变体换色)
window.Sprites = (() => {
  "use strict";

  const FIXED = {
    W: "#ffffff", K: "#272732", B: "#ff9db4",
    m: "#f3eee3", c: "#7c4a21", s: "#c9d4e8",
    g: "#9aa3b2", G: "#5f6877", y: "#f6c344",
    r: "#e5534b", R: "#b03a34",
    w: "#b98a5e", v: "#8a6542", l: "#d7b289",
    e: "#3fa66a", E: "#2d7d4f", n: "#3d9ae8",
    o: "#f29e4c", S: "#3b4252", O: "#5b6480",
  };

  function paletteFor(hue) {
    return {
      P: `hsl(${hue} 62% 55%)`,
      D: `hsl(${hue} 52% 40%)`,
      H: `hsl(${hue} 75% 72%)`,
      ...FIXED,
    };
  }

  // ---------- 工具 ----------
  // 在 base 上盖一个小图章(block),"."不覆盖
  function stamp(base, ox, oy, block) {
    const out = base.slice();
    block.forEach((br, dy) => {
      const y = oy + dy;
      if (y < 0 || y >= out.length) return;
      const row = out[y].split("");
      for (let dx = 0; dx < br.length; dx++) {
        const ch = br[dx];
        const x = ox + dx;
        if (ch !== "." && x >= 0 && x < row.length) row[x] = ch;
      }
      out[y] = row.join("");
    });
    return out;
  }
  const mirror = (rows) => rows.map((r) => r.split("").reverse().join(""));
  const down1 = (rows) => [".".repeat(rows[0].length), ...rows.slice(0, rows.length - 1)];

  // ---------- Claude 小章鱼(Clawd)本体 16×18 ----------
  // 官方吉祥物造型:宽方圆角身体 + 两条竖黑条眼睛 + 侧边小手 + 底下短腿。
  // 顶部 3 行留空,给杠铃/星星等头顶图章用。
  const BODY = [
    "................",
    "................",
    "................",
    "..PPPPPPPPPPPP..",
    ".PHHPPPPPPPPPPD.",
    ".PHPPPPPPPPPPPD.",
    ".PPPPKPPPPKPPPD.",
    ".PPPPKPPPPKPPPD.",
    ".PPPPKPPPPKPPPD.",
    ".PPPPPPPPPPPPPD.",
    ".PPPPPPPPPPPPPD.",
    ".PPPPPPPPPPPPPD.",
    ".PDPPPPPPPPPPPD.",
    "..DDDDDDDDDDDD..",
  ];
  // 腿(4 行):站立 / 螃蟹碎步两态
  const LEGS_STAND = [
    "..PP..PP..PP.PP.",
    "..PP..PP..PP.PP.",
    "..DD..DD..DD.DD.",
    "................",
  ];
  const LEGS_W1 = [
    "..PP..PP..PP.PP.",
    "..PP......PP....",
    "..DD......DD....",
    "................",
  ];
  const LEGS_W2 = [
    "..PP..PP..PP.PP.",
    "......PP.....PP.",
    "......DD.....DD.",
    "................",
  ];
  const bodyOf = (legs) => [...BODY, ...legs];

  // ---------- 图章部件 ----------
  const ARM = ["P", "D"]; // 1×2 侧边小手
  const MUG = ["mmm", "mcm", "mmm"];
  const STEAM = ["s..", ".s.", "..s"];
  const BAR = ["yy............yy", "yyGggggggggggGyy", "yy............yy"]; // 杠铃
  const EYE_SLEEP = ["PPP", "PPP", "KKK"]; // 闭眼(盖掉竖条眼,留一道横线)
  const EYE_WIDE = ["KK", "KK", "KK"]; // 瞪大
  const SPARK = ["y"];
  const PAD1 = [".GGGG.", "GyGGoG", ".gGGg."]; // 手柄(按键灯黄左橙右)
  const PAD2 = [".GGGG.", "GoGGyG", ".gGGg."]; // 手柄(按键灯交替闪)
  const BOX_S = ["llllll", "wwyyww", "wwwwww"]; // 头顶小纸箱(y=胶带)

  const withArms = (base, ly, ry) => stamp(stamp(base, 0, ly, ARM), 15, ry, ARM);
  const closedEyes = (base) => stamp(stamp(base, 4, 6, EYE_SLEEP), 9, 6, EYE_SLEEP);

  const stand = withArms(bodyOf(LEGS_STAND), 8, 8);
  const walk1 = withArms(bodyOf(LEGS_W1), 8, 8);
  const walk2 = withArms(bodyOf(LEGS_W2), 8, 8);

  // ---------- 动画帧 ----------
  const FRAMES = {
    idle: [stand, down1(stand)],
    type: [
      withArms(bodyOf(LEGS_STAND), 5, 10),
      withArms(bodyOf(LEGS_STAND), 7, 8),
      withArms(bodyOf(LEGS_STAND), 10, 5),
      withArms(bodyOf(LEGS_STAND), 8, 7),
    ],
    walk: [walk1, stand, walk2, stand],
    coffee: [
      stamp(stand, 12, 10, MUG),
      stamp(stand, 12, 8, MUG),
      stamp(stamp(withArms(bodyOf(LEGS_STAND), 8, 5), 12, 6, MUG), 12, 2, STEAM),
      stamp(stand, 12, 8, MUG),
    ],
    lift: [
      stamp(stand, 0, 12, BAR),
      stamp(stand, 0, 7, BAR),
      stamp(withArms(bodyOf(LEGS_STAND), 4, 4), 0, 0, BAR),
      stamp(stand, 0, 7, BAR),
    ],
    run: [
      stamp(walk1, 15, 3, ["s"]),
      stand,
      walk2,
      stamp(stand, 15, 3, ["s"]),
    ],
    sleep: [
      closedEyes(stand),
      down1(closedEyes(stand)),
    ],
    celebrate: [
      withArms(bodyOf(LEGS_STAND), 4, 4),
      withArms(bodyOf(LEGS_STAND), 6, 6),
      stamp(stamp(withArms(bodyOf(LEGS_STAND), 4, 4), 2, 0, SPARK), 13, 1, SPARK),
    ],
    alert: [stamp(stamp(stand, 4, 6, EYE_WIDE), 9, 6, EYE_WIDE)],
    // 坐工位摸鱼打游戏:怀抱手柄、按键灯闪、身体随节奏轻晃
    game: [
      stamp(withArms(bodyOf(LEGS_STAND), 9, 9), 5, 9, PAD1),
      down1(stamp(withArms(bodyOf(LEGS_STAND), 9, 9), 5, 9, PAD2)),
    ],
    // 头顶纸箱行走(顶部 3 行预留区正好放箱子)
    carry: [
      stamp(walk1, 5, 0, BOX_S),
      stamp(stand, 5, 0, BOX_S),
      stamp(walk2, 5, 0, BOX_S),
      stamp(stand, 5, 0, BOX_S),
    ],
  };

  const ANIMS = {
    idle: { frames: 2, fps: 2 },
    type: { frames: 4, fps: 8 },
    walk: { frames: 4, fps: 7 },
    coffee: { frames: 4, fps: 3 },
    lift: { frames: 4, fps: 4 },
    run: { frames: 4, fps: 9 },
    sleep: { frames: 2, fps: 1 },
    celebrate: { frames: 3, fps: 5 },
    alert: { frames: 1, fps: 1 },
    game: { frames: 2, fps: 4 },
    carry: { frames: 4, fps: 7 },
  };

  // ---------- 家具 ----------
  // 工位桌:桌子 + 背对观众的笔记本(O = 屏沿光,变体换色)
  const DESK = [
    "......OOOOOOOO......",
    "......SSSSSSSS......",
    "......SSSSSSSS......",
    "......SSooSSSS......",
    "......SSSSSSSS......",
    ".....GGGGGGGGGG.....",
    "llllllllllllllllllll",
    "wwwwwwwwwwwwwwwwwwww",
    "vvvvvvvvvvvvvvvvvvvv",
    ".vv..............vv.",
    ".vv..............vv.",
    ".vv..............vv.",
    ".vv..............vv.",
  ];
  // 经理大桌:更宽 + 铭牌
  const DESK_MGR = [
    "........OOOOOOOOOO........",
    "........SSSSSSSSSS........",
    "........SSSSSSSSSS........",
    "........SSSooSSSSS........",
    "........SSSSSSSSSS........",
    ".......GGGGGGGGGGGG.......",
    "lllyylllllllllllllllllllll",
    "wwwwwwwwwwwwwwwwwwwwwwwwww",
    "vvvvvvvvvvvvvvvvvvvvvvvvvv",
    ".vv....................vv.",
    ".vv....................vv.",
    ".vv....................vv.",
    ".vv....................vv.",
  ];
  const COFFEE_MACHINE = [
    "GGGGGGGGGGGG",
    "GggggggggggG",
    "GggrgggggggG",
    "GggggggggggG",
    "GGGGGGGGGGGG",
    "GGKKKKKKKKGG",
    "GGKKsKKKKKGG",
    "GGKKmmKKKKGG",
    "GGKKmmKKKKGG",
    "GGKKKKKKKKGG",
    "GGGGGGGGGGGG",
    "GGGGGGGGGGGG",
    "wwwwwwwwwwww",
    "vvvvvvvvvvvv",
    ".vv......vv.",
    ".vv......vv.",
    ".vv......vv.",
  ];
  const WATER_COOLER = [
    "..nnnnnn..",
    ".nnnnnnnn.",
    ".nWnnnnnn.",
    ".nnnnnnnn.",
    "mmmmmmmmmm",
    "mmmmmmmmmm",
    "mmrnmmmmmm",
    "mmKKKKKKmm",
    "mmmmmmmmmm",
    "mmmmmmmmmm",
    "mmmmmmmmmm",
    ".mm....mm.",
    ".mm....mm.",
  ];
  const TREADMILL = [
    ".gg...................",
    ".gg...................",
    ".gggggg...............",
    ".gg...................",
    ".gg...................",
    ".gg...................",
    "GGGGGGGGGGGGGGGGGGGGGG",
    "GKKKKKKKKKKKKKKKKKKKKG",
    "GGGGGGGGGGGGGGGGGGGGGG",
    ".gg................gg.",
  ];
  const DUMBBELLS = [
    ".yggy.yggy.yggy.",
    "GGGGGGGGGGGGGGGG",
    "................",
    ".yggy.yggy.yggy.",
    "GGGGGGGGGGGGGGGG",
    ".GG..........GG.",
    ".GG..........GG.",
  ];
  const PLANT = [
    "....eee.....",
    "..eeeEee....",
    ".eeEeeeeee..",
    ".eeeeEeeee..",
    "..eEeeeEe...",
    "....Ee......",
    "....ww......",
    "...wwww.....",
    "...wvvw.....",
    "...wvvw.....",
    "....ww......",
  ];
  const SOFA = [
    ".rrrrrrrrrrrrrrrrrrrrrr.",
    ".rrrrrrrrrrrrrrrrrrrrrr.",
    "rrrRRRRRRRRRRRRRRRRRRrrr",
    "rrRRRRRRRRRRRRRRRRRRRRrr",
    "rrrrrrrrrrrrrrrrrrrrrrrr",
    "rrrrrrrrrrrrrrrrrrrrrrrr",
    ".ww..................ww.",
  ];
  const DOOR = [
    "wwwwwwwwwwwwww",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvyvw",
    "wvvvvvvvvvvyvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wvvvvvvvvvvvvw",
    "wwwwwwwwwwwwww",
  ];
  const WHITEBOARD = [
    "gggggggggggggggggggg",
    "gmmmmmmmmmmmmmmmmmmg",
    "gmnnnnnmmmmmmmmmmmmg",
    "gmmmmmmmmmmmmmmmmmmg",
    "gmrrrrrrrmmmmmmmmmmg",
    "gmmmmmmmmmmmmmmmmmmg",
    "gmeeeeemmmmmemmmmmmg",
    "gmmmmmmmmmmmmmmmmmmg",
    "gggggggggggggggggggg",
  ];
  // 储物货架:3 层格架,箱子(box)由 office.js 按 state.dirs 动态摆进格子
  // 34 宽:2 侧柱 + 30 内空;每层开口 6 行(正好放下 8×6 的大箱子)
  const SHELF_BOARD = "w".repeat(34);
  const SHELF_GAP = "vv" + ".".repeat(30) + "vv";
  const SHELF = [
    SHELF_BOARD,
    ...Array(6).fill(SHELF_GAP),
    SHELF_BOARD,
    ...Array(6).fill(SHELF_GAP),
    SHELF_BOARD,
    ...Array(6).fill(SHELF_GAP),
    SHELF_BOARD,
  ];
  // 大纸箱(摆货架格/工位旁)
  const BOX_L = [
    "llllllll",
    "wwwyywww",
    "wwwyywww",
    "wwwyywww",
    "wwwwwwww",
    "vvvvvvvv",
  ];

  const FURNITURE = {
    desk: {
      rows: DESK,
      variants: { off: { O: "#5b6480" }, on0: { O: "#7ee2a8" }, on1: { O: "#b9f2d0" } },
    },
    deskMgr: {
      rows: DESK_MGR,
      variants: { off: { O: "#5b6480" }, on0: { O: "#7ee2a8" }, on1: { O: "#b9f2d0" } },
    },
    coffee: { rows: COFFEE_MACHINE },
    cooler: { rows: WATER_COOLER },
    treadmill: { rows: TREADMILL },
    dumbbells: { rows: DUMBBELLS },
    plant: { rows: PLANT },
    sofa: { rows: SOFA },
    door: { rows: DOOR },
    whiteboard: { rows: WHITEBOARD },
    shelf: { rows: SHELF },
    box: { rows: BOX_L },
  };

  // ---------- 校验(出错就大声失败) ----------
  function validate() {
    for (const [name, frames] of Object.entries(FRAMES)) {
      frames.forEach((rows, i) => {
        if (rows.length !== 18) throw new Error(`Sprite ${name}[${i}] 高度 ${rows.length}≠18`);
        rows.forEach((r, y) => {
          if (r.length !== 16) throw new Error(`Sprite ${name}[${i}] 第${y}行宽度 ${r.length}≠16`);
        });
      });
      if (ANIMS[name].frames !== frames.length)
        throw new Error(`ANIMS.${name}.frames=${ANIMS[name].frames} 与实际 ${frames.length} 不符`);
    }
    for (const [name, f] of Object.entries(FURNITURE)) {
      const w = f.rows[0].length;
      f.rows.forEach((r, y) => {
        if (r.length !== w) throw new Error(`家具 ${name} 第${y}行宽度 ${r.length}≠${w}`);
      });
    }
  }
  validate();

  // ---------- 渲染 + 缓存 ----------
  function renderRows(rows, palette) {
    const h = rows.length, w = rows[0].length;
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ch = rows[y][x];
        if (ch === ".") continue;
        const col = palette[ch];
        if (!col) throw new Error(`未知像素字符 "${ch}"`);
        ctx.fillStyle = col;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    return cv;
  }

  const frameCache = new Map(); // "anim:idx:hue" -> canvas
  function getFrameCanvas(anim, idx, hue) {
    const key = `${anim}:${idx}:${hue}`;
    let cv = frameCache.get(key);
    if (!cv) {
      cv = renderRows(FRAMES[anim][idx], paletteFor(hue));
      frameCache.set(key, cv);
    }
    return cv;
  }

  const furnCache = new Map(); // "name:variant" -> canvas
  function getFurnitureCanvas(name, variant) {
    const key = `${name}:${variant || ""}`;
    let cv = furnCache.get(key);
    if (!cv) {
      const f = FURNITURE[name];
      const pal = { ...paletteFor(243), ...(variant && f.variants ? f.variants[variant] : {}) };
      cv = renderRows(f.rows, pal);
      furnCache.set(key, cv);
    }
    return cv;
  }

  // ---------- 调试画廊 ?debug=sprites ----------
  function gallery() {
    document.body.innerHTML = "";
    document.body.style.cssText = "background:#23252f;color:#dde2f0;font:13px/1.6 monospace;padding:20px";
    const hues = [243, 25, 130, 200, 330];
    const h1 = document.createElement("h2");
    h1.textContent = "Sprite 画廊 · 章鱼动画 × 色相";
    document.body.appendChild(h1);
    for (const anim of Object.keys(FRAMES)) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:16px;align-items:center;margin:10px 0";
      const lab = document.createElement("span");
      lab.textContent = anim.padEnd(10);
      lab.style.width = "90px";
      row.appendChild(lab);
      for (const hue of hues) {
        const cv = document.createElement("canvas");
        cv.width = 16; cv.height = 18;
        cv.style.cssText = "width:96px;height:108px;image-rendering:pixelated;background:#2e3140;border-radius:6px";
        row.appendChild(cv);
        const ctx = cv.getContext("2d");
        let i = 0;
        const draw = () => {
          ctx.clearRect(0, 0, 16, 18);
          ctx.drawImage(getFrameCanvas(anim, i % ANIMS[anim].frames, hue), 0, 0);
          i++;
        };
        draw();
        setInterval(draw, 1000 / ANIMS[anim].fps);
      }
      document.body.appendChild(row);
    }
    const h2 = document.createElement("h2");
    h2.textContent = "家具";
    document.body.appendChild(h2);
    const frow = document.createElement("div");
    frow.style.cssText = "display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap";
    for (const name of Object.keys(FURNITURE)) {
      const wrap = document.createElement("div");
      wrap.style.textAlign = "center";
      const src = getFurnitureCanvas(name, FURNITURE[name].variants ? "on0" : undefined);
      const cv = document.createElement("canvas");
      cv.width = src.width; cv.height = src.height;
      cv.style.cssText = `width:${src.width * 4}px;height:${src.height * 4}px;image-rendering:pixelated`;
      cv.getContext("2d").drawImage(src, 0, 0);
      const lab = document.createElement("div");
      lab.textContent = name;
      wrap.appendChild(cv); wrap.appendChild(lab);
      frow.appendChild(wrap);
    }
    document.body.appendChild(frow);
  }
  if (new URLSearchParams(location.search).get("debug") === "sprites") {
    addEventListener("DOMContentLoaded", gallery);
  }

  return { SCALE: 3, W: 16, H: 18, ANIMS, paletteFor, getFrameCanvas, getFurnitureCanvas };
})();
