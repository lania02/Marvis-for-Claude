// 迷你 MCP server(stdio,零依赖):给驻场会话当 --permission-prompt-tool 用。
// claude 需要权限时调用 approve 工具 → 本进程把请求转发给可视化 server →
// 前端弹审批卡 → 用户点允许/拒绝 → 决定回传给 claude。
// 协议:MCP stdio = 每行一条 JSON-RPC 2.0 消息。
// 环境变量:CC_VIZ_PORT(默认 4317)、CC_VIZ_SESSION(归属会话,用于前端展示)。

const PORT = process.env.CC_VIZ_PORT || "4317";
const SESSION = process.env.CC_VIZ_SESSION || "";
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT_TOTAL_MS = 30 * 60 * 1000; // 最长等用户 30 分钟,超时拒绝

const TOOL = {
  name: "approve",
  description: "Forward a permission request to the CC visualization UI and wait for the user's decision.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

async function decide(params) {
  const toolName = params?.tool_name || "unknown";
  const input = params?.input ?? {};
  // 1) 登记审批请求
  const reg = await fetch(`${BASE}/api/approval/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: SESSION, toolName, input }),
  }).then((r) => r.json());
  if (reg.decision) return finish(reg.decision, input); // 命中"总是允许"
  const id = reg.id;
  // 2) 长轮询等用户决定
  const deadline = Date.now() + WAIT_TOTAL_MS;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/approval/wait?id=${encodeURIComponent(id)}`).then((x) => x.json());
    if (r.decision) return finish(r.decision, input);
  }
  return { behavior: "deny", message: "可视化端 30 分钟无人响应,自动拒绝" };
}

function finish(d, input) {
  if (d.behavior === "allow") return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: d.message || "用户在可视化面板拒绝了该操作" };
}

let buf = "";
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      if (msg.method === "initialize") {
        reply(msg.id, {
          protocolVersion: msg.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "viz", version: "1.0.0" },
        });
      } else if (msg.method === "tools/list") {
        reply(msg.id, { tools: [TOOL] });
      } else if (msg.method === "tools/call" && msg.params?.name === "approve") {
        const decision = await decide(msg.params.arguments);
        reply(msg.id, { content: [{ type: "text", text: JSON.stringify(decision) }] });
      } else if (msg.id != null) {
        // 未知请求:按 JSON-RPC 规范回 method not found
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
      }
      // 通知(无 id,如 notifications/initialized)直接忽略
    } catch (e) {
      // 可视化 server 不在线等情况:拒绝,绝不让 claude 卡死
      if (msg.id != null && msg.method === "tools/call") {
        reply(msg.id, { content: [{ type: "text", text: JSON.stringify({ behavior: "deny", message: "审批通道异常: " + (e.message || e) }) }] });
      }
    }
  }
});
process.stdin.on("end", () => process.exit(0));
