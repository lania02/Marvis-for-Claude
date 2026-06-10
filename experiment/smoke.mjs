// 冒烟测试：两个会话(不同 cwd)交错推进，校验多会话归属与楼层分组
const BASE = "http://127.0.0.1:4317";
const A = "ac056815ec3856624";
const B = "a965603eaa7fc2206";

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.text();
}

const CWD1 = "C:\\proj\\alpha";
const CWD2 = "C:\\proj\\beta";

// 两个会话交错:s1 在 alpha 跑两个子 agent;s2 在 beta 单独干活并结束
const seq = [
  { hook_event_name: "SessionStart", session_id: "s1", cwd: CWD1, source: "startup" },
  { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: CWD1, prompt: "并行跑两个子 agent" },
  { hook_event_name: "SessionStart", session_id: "s2", cwd: CWD2, source: "startup" },
  { hook_event_name: "UserPromptSubmit", session_id: "s2", cwd: CWD2, prompt: "另一个项目里修 bug" },
  { hook_event_name: "PreToolUse", session_id: "s1", cwd: CWD1, tool_name: "Agent", tool_use_id: "t_spawnA", tool_input: { subagent_type: "general-purpose", description: "查文件" } },
  { hook_event_name: "PreToolUse", session_id: "s2", cwd: CWD2, tool_name: "Read", tool_use_id: "s2r1", tool_input: { file_path: "src/main.ts" } },
  { hook_event_name: "PreToolUse", session_id: "s1", cwd: CWD1, tool_name: "Agent", tool_use_id: "t_spawnB", tool_input: { subagent_type: "general-purpose", description: "查日期" } },
  { hook_event_name: "SubagentStart", session_id: "s1", cwd: CWD1, agent_id: A, agent_type: "general-purpose" },
  { hook_event_name: "SubagentStart", session_id: "s1", cwd: CWD1, agent_id: B, agent_type: "general-purpose" },
  { hook_event_name: "PostToolUse", session_id: "s2", cwd: CWD2, tool_name: "Read", tool_use_id: "s2r1", duration_ms: 80, tool_response: "ok" },
  { hook_event_name: "PreToolUse", session_id: "s1", cwd: CWD1, agent_id: A, agent_type: "general-purpose", tool_name: "PowerShell", tool_use_id: "tA1", tool_input: { command: 'echo "HELLO-FROM-A"' } },
  { hook_event_name: "PreToolUse", session_id: "s1", cwd: CWD1, agent_id: B, agent_type: "general-purpose", tool_name: "PowerShell", tool_use_id: "tB1", tool_input: { command: "echo HELLO-FROM-B" } },
  { hook_event_name: "PostToolUse", session_id: "s1", cwd: CWD1, agent_id: B, agent_type: "general-purpose", tool_name: "PowerShell", tool_use_id: "tB1", duration_ms: 120, tool_response: "HELLO-FROM-B" },
  { hook_event_name: "PostToolUse", session_id: "s1", cwd: CWD1, agent_id: A, agent_type: "general-purpose", tool_name: "PowerShell", tool_use_id: "tA1", duration_ms: 90, tool_response: "HELLO-FROM-A" },
  { hook_event_name: "Stop", session_id: "s2", cwd: CWD2, last_assistant_message: "bug 已修" },
  { hook_event_name: "SessionEnd", session_id: "s2", cwd: CWD2 },
  { hook_event_name: "SubagentStop", session_id: "s1", cwd: CWD1, agent_id: B, agent_type: "general-purpose", last_assistant_message: "Command executed successfully." },
  { hook_event_name: "PostToolUse", session_id: "s1", cwd: CWD1, tool_name: "Agent", tool_use_id: "t_spawnB", duration_ms: 2000, tool_response: "ok" },
  { hook_event_name: "SubagentStop", session_id: "s1", cwd: CWD1, agent_id: A, agent_type: "general-purpose", last_assistant_message: "Done. Output is HELLO-FROM-A" },
  { hook_event_name: "PostToolUse", session_id: "s1", cwd: CWD1, tool_name: "Agent", tool_use_id: "t_spawnA", duration_ms: 2100, tool_response: "ok" },
  { hook_event_name: "Stop", session_id: "s1", cwd: CWD1, last_assistant_message: "DONE" },
];

for (const e of seq) await post("/event", e);

const { index, states } = await (await fetch(BASE + "/api/state")).json();

let fail = 0;
const check = (cond, msg) => {
  console.log((cond ? "  ✅" : "  ❌") + " " + msg);
  if (!cond) fail++;
};

console.log("楼层(index):");
for (const f of index) {
  console.log(`  ${f.name} (${f.cwd}) → ${f.sessions.map((s) => `${s.sessionId}[${s.status}${s.ended ? "/ended" : ""}]`).join(", ")}`);
}
check(index.length >= 2, "至少两个楼层");
check(index.some((f) => f.cwd === CWD1) && index.some((f) => f.cwd === CWD2), "alpha/beta 各占一层");

const s1 = states.s1, s2 = states.s2;
console.log("\n会话 s1:");
check(s1.status === "done" && s1.cwd === CWD1, `status=done cwd=alpha (实际 ${s1.status} ${s1.cwd})`);
check(Object.keys(s1.agents).length === 3, `3 个 agent (实际 ${Object.keys(s1.agents).length})`);
check(s1.agents[A]?.toolCount === 1 && s1.agents[B]?.toolCount === 1, "子 agent 工具归属各 1");
check(s1.agents.root.spawnCount === 2, `root 派活 2 (实际 ${s1.agents.root.spawnCount})`);
check(!s1.tools.some((t) => t.agentKey === "root" && t.name === "Read"), "s2 的 Read 没串进 s1");

console.log("\n会话 s2:");
check(s2.status === "done" && s2.ended === true, `done + ended (实际 ${s2.status} ended=${s2.ended})`);
check(s2.stats.totalTools === 1, `只有 1 次工具 (实际 ${s2.stats.totalTools})`);
check(s2.cwd === CWD2, `cwd=beta (实际 ${s2.cwd})`);

console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exitCode = fail ? 1 : 0; // 不用 process.exit():Windows 上会和 fetch keep-alive 冲突触发 libuv 断言

