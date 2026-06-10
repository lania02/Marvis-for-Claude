#!/usr/bin/env node
// 把 CC 可视化的 hooks 安全合并进 Claude Code 的 settings.json。
//
//   node install.mjs                 安装到全局 ~/.claude/settings.json（捕获你所有会话）
//   node install.mjs --project       只装到当前项目 ./.claude/settings.json
//   node install.mjs --path X.json   指定 settings 文件
//   node install.mjs --port 5000     使用自定义端口（需与服务的 CC_VIZ_PORT 一致）
//   node install.mjs --uninstall     干净移除本工具写入的 hooks
//
// 特性：写入前自动备份；幂等（重复执行不重复添加）；只动我们自己的条目，保留你已有的 hooks。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const PORT = Number(val("--port") || process.env.CC_VIZ_PORT) || 4317;
const URL = `http://127.0.0.1:${PORT}/event`;
const UNINSTALL = has("--uninstall");

let target;
if (val("--path")) target = path.resolve(val("--path"));
else if (has("--project")) target = path.resolve(".claude", "settings.json");
else target = path.join(os.homedir(), ".claude", "settings.json");

// 需要 matcher 的事件（工具 / 子 agent 类）
const WITH_MATCHER = new Set([
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop",
]);
const EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "SubagentStart", "SubagentStop", "Stop", "SessionEnd",
];

function ourEntry(event) {
  const entry = { hooks: [{ type: "http", url: URL, timeout: 5 }] };
  if (WITH_MATCHER.has(event)) entry.matcher = ".*";
  return entry;
}

// 判断某个 hook 分组是否是我们写入的（按 url 端口识别）
function isOurs(group) {
  return (
    group &&
    Array.isArray(group.hooks) &&
    group.hooks.some(
      (h) => h && h.type === "http" && typeof h.url === "string" && h.url.includes(`127.0.0.1:${PORT}/event`)
    )
  );
}

// 读取现有 settings
let settings = {};
if (fs.existsSync(target)) {
  try {
    settings = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (e) {
    console.error(`✗ 无法解析 ${target}：${e.message}`);
    process.exit(1);
  }
  // 备份
  const bak = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(target, bak);
  console.log(`  已备份原文件 → ${bak}`);
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
}

settings.hooks = settings.hooks || {};

let added = 0;
let removed = 0;
for (const event of EVENTS) {
  const arr = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const kept = arr.filter((g) => {
    if (isOurs(g)) {
      removed++;
      return false;
    }
    return true;
  });
  if (!UNINSTALL) {
    kept.push(ourEntry(event));
    added++;
  }
  if (kept.length) settings.hooks[event] = kept;
  else delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n", "utf8");

console.log("");
if (UNINSTALL) {
  console.log(`✓ 已卸载：从 ${target} 移除 ${removed} 个 hook 分组`);
} else {
  console.log(`✓ 已安装：在 ${target} 写入 ${added} 个事件的 hook（覆盖了 ${removed} 个旧条目）`);
  console.log(`  事件入口：${URL}`);
  console.log("");
  console.log("  下一步：");
  console.log(`    1) 启动服务：  node server/server.mjs   （或 npm start）`);
  console.log(`    2) 打开面板：  http://127.0.0.1:${PORT}/`);
  console.log(`    3) 在任意目录开新的 Claude Code 会话即可看到办公室动起来`);
  console.log("");
  console.log("  注：hooks 在新会话生效；当前已开的会话需重启。服务未开时连接失败为非阻塞，不影响使用。");
}
