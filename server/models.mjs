// 从 transcript JSONL 提取 agent 当前使用的模型。
// hook payload 不带 model 字段,但 transcript 的 assistant 消息里有 "model":"claude-xxx"。
// 主 agent 读 transcript_path;子 agent 读同目录 agent-<agent_id>.jsonl。
// 只读文件尾部 64KB + 15s TTL 缓存,绝不阻塞 hook 响应路径。
import fs from "node:fs";
import path from "node:path";

const TAIL_BYTES = 64 * 1024;
const TTL = 15000;
const cache = new Map(); // file -> { model, at }

// claude-sonnet-4-5-20250929 → sonnet-4.5;claude-fable-5 → fable-5
export function shortName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (!m) return id.replace(/^claude-/, "");
  // 第三段是日期(8位)就丢弃,是小版本(1-2位)就拼上
  const minor = m[3] && m[3].length <= 2 ? "." + m[3] : "";
  return `${m[1]}-${m[2]}${minor}`;
}

async function readTailModel(file) {
  const fd = await fs.promises.open(file, "r");
  try {
    const { size } = await fd.stat();
    const len = Math.min(size, TAIL_BYTES);
    if (!len) return null;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, size - len);
    // 不做 JSON.parse:尾部第一行可能被截断,正则扫描更鲁棒;取最后一次出现
    const all = [...buf.toString("utf8").matchAll(/"model"\s*:\s*"(claude-[\w.-]+)"/g)];
    return all.length ? shortName(all[all.length - 1][1]) : null;
  } finally {
    await fd.close();
  }
}

// p = hook payload。返回缩写模型名或 null(transcript 不存在/还没有 assistant 消息)。
// force=true 绕过 TTL(SubagentStop 是该 agent 最后一个事件,必须趁机重读)。
export async function modelFor(p, force = false) {
  if (!p?.transcript_path) return null;
  // 子 agent transcript 在 <transcript同名目录>/subagents/agent-<id>.jsonl
  // (例: .../projects/xxx/<session_id>.jsonl → .../projects/xxx/<session_id>/subagents/agent-<id>.jsonl)
  const file = p.agent_id
    ? path.join(p.transcript_path.replace(/\.jsonl$/i, ""), "subagents", `agent-${p.agent_id}.jsonl`)
    : p.transcript_path;
  const hit = cache.get(file);
  if (hit && !force && Date.now() - hit.at < TTL) return hit.model;
  cache.set(file, { model: hit?.model ?? null, at: Date.now() }); // 先占位,防并发重读
  let model = null;
  try {
    model = await readTailModel(file);
  } catch {
    // 文件尚不存在(子 agent transcript 延迟落盘)→ 静默,下个 TTL 周期自动重试
  }
  if (model) cache.set(file, { model, at: Date.now() });
  return model;
}
