#!/usr/bin/env node
// 捕获 Claude Code hook 实际发送的 payload，逐行追加到 captured.log
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, "captured.log");

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    parsed = { __parse_error: String(e) };
  }
  const entry = {
    received_at: new Date().toISOString(),
    pid: process.pid,
    argv: process.argv.slice(2),
    stdin_len: raw.length,
    payload: parsed,
  };
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n", "utf8");
  // hook 必须正常退出，不阻塞
  process.exit(0);
});
// 兜底：若 200ms 内没有 stdin，也记录一条
setTimeout(() => {
  if (raw.length === 0) {
    fs.appendFileSync(
      LOG,
      JSON.stringify({
        received_at: new Date().toISOString(),
        pid: process.pid,
        argv: process.argv.slice(2),
        stdin_len: 0,
        payload: null,
        note: "no-stdin",
      }) + "\n",
      "utf8"
    );
    process.exit(0);
  }
}, 200);
