// AI 自由发挥台词:根据会话真实日志,一次性调 `claude -p --model haiku` 生成双章鱼闲聊剧本。
// 防呆三件套:
//   1. --session-id 预生成 UUID 并通过 registerIgnore 上报 → 生成会话的 hooks 被 server 丢弃,不会变成可视化里的房间
//   2. 节流:同一会话 60s 一次、全局同时只跑一个,失败/超时静默(前端自动回退台词库)
//   3. 用户文本只走 stdin,argv 全是固定 flag + UUID
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveClaude } from "./managed.mjs";

const COOLDOWN_MS = 60 * 1000;
const TIMEOUT_MS = 25 * 1000;
const lastGenAt = new Map(); // sid -> ts
let busy = false;

const PROMPT = {
  zh: (ctx) => `你是像素办公室可视化里的两只小章鱼员工(Claude Code agent 拟人化)。根据下面这个会话的真实工作日志,写一段两只章鱼之间的闲聊:像同事八卦,俏皮、具体,可以点名吐槽日志里出现的文件名/工具/报错/任务内容。2 到 3 句,轮流说话,每句不超过 38 个字。只输出一个 JSON 字符串数组(如 ["...","..."]),不要输出任何其他文字。\n\n最近日志:\n${ctx}`,
  en: (ctx) => `You are two octopus employees in a pixel-office visualization (personified Claude Code agents). Based on this session's real work log below, write a short gossip between the two: playful, specific, free to roast the file names / tools / errors / task in the log. 2-3 lines, alternating speakers, each line under 90 characters. Output ONLY a JSON string array (e.g. ["...","..."]), nothing else.\n\nRecent log:\n${ctx}`,
};

export function createQuipGen(registerIgnore) {
  const claudeExe = resolveClaude();

  function generate(sid, lang, context) {
    return new Promise((resolve) => {
      if (!claudeExe || busy) return resolve(null);
      const now = Date.now();
      if (now - (lastGenAt.get(sid) || 0) < COOLDOWN_MS) return resolve(null);
      lastGenAt.set(sid, now);
      busy = true;

      const genSid = randomUUID();
      registerIgnore(genSid); // 这个一次性会话的 hooks 全部丢弃
      const child = spawn(claudeExe, ["-p", "--model", "haiku", "--session-id", genSid], {
        cwd: process.cwd(),
        shell: true,
        windowsHide: true,
      });
      let out = "";
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stdin.on("error", () => {});
      child.on("error", () => {
        clearTimeout(timer);
        busy = false;
        resolve(null);
      });
      child.on("exit", () => {
        clearTimeout(timer);
        busy = false;
        resolve(parseLines(out));
      });
      child.stdin.write((PROMPT[lang] || PROMPT.zh)(context));
      child.stdin.end();
    });
  }

  return { available: !!claudeExe, generate };
}

function parseLines(out) {
  const m = out.match(/\[[\s\S]*\]/); // 取第一段 JSON 数组(模型偶尔会包一句话)
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    const lines = arr.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 90)).slice(0, 4);
    return lines.length >= 2 ? lines : null;
  } catch {
    return null;
  }
}
