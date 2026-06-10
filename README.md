# CC 可视化 · Agent 办公室

Claude Code 多 agent 实时协作可视化工具，灵感来自腾讯马维斯（Marvis）的"办公室"场景：把主控 PM 和并行的子 agent 拟人化成一间**像素风办公室**里的彩色 Claude Code 小章鱼员工——工作时坐在工位上敲键盘（头顶实时显示正在跑的工具），空闲时会自己溜达去喝咖啡、举铁、跑步机、沙发打盹，还会随机吐槽（嵌入真实的工具名/文件名/耗时/报错）、两只空闲章鱼碰上还会互相闲聊。让多 agent 的黑盒执行变得可读、可爱。

- 🐙 **像素章鱼员工**：每个 agent 一只专属颜色的小章鱼（颜色由 `agent_id` 哈希生成，与日志色点一致），敲键盘 / 行走 / 喝咖啡 / 举铁 / 跑步 / 打盹 / 打游戏 / 庆祝全套逐帧动画，零图片资源——全部由 JS 像素矩阵运行时绘制。空闲时大概率窝在工位上打游戏摸鱼，偶尔才起身去茶水间/健身角，动作节奏舒缓不乱跑
- 🏢 **2D 办公室场景**：经理区、员工工位（随 agent 数量自动扩展）、茶水间（咖啡机+饮水机）、健身角（哑铃架+跑步机）、沙发区、绿植、白板
- 💬 **彩蛋对话**：工作吐槽、报错翻车、收工庆祝、设施专属台词、双章鱼成对闲聊；点击章鱼可看详情卡（当前工具、耗时、统计、产出）
- 🔍 **sprite 调试画廊**：访问 `http://127.0.0.1:4317/?debug=sprites` 可预览全部动画 × 多色相

**零依赖**（纯 Node.js 标准库 + 原生前端），Windows / macOS / Linux 通用。

---

## 截图位

启动后访问 `http://127.0.0.1:4317/`，点右上角「▶ 演示」即可看到一个内置剧本（PM 拆解任务 → 3 个子 agent 并行重构 / 写测试 / 改文档）跑完整流程。

---

## 30 秒上手

```bash
# 1. 启动服务（零依赖，无需 npm install）
node server/server.mjs          # 或：npm start

# 2. 打开面板，先点「▶ 演示」感受效果
#    http://127.0.0.1:4317/

# 3. 接到真实 Claude Code 会话：注册 hooks
node install.mjs                 # 装到全局，捕获你所有会话
#   或 node install.mjs --project  只捕获当前项目

# 4. 开一个新的 Claude Code 会话，让它跑点活（尤其是派子 agent 的任务），
#    办公室就会实时动起来。
```

卸载 hooks：`node install.mjs --uninstall`（会自动备份、且只移除本工具写入的条目）。

---

## 架构

三层，数据单向流动：

```
Claude Code 会话
   │  hooks（type:http，每个生命周期事件 POST 一条 JSON）
   ▼
本地服务  server/server.mjs
   ├─ /event      采集 hook 事件
   ├─ state.mjs   归约成「会话 / agent / 工具调用」三层状态
   └─ /events     SSE 实时推送状态快照
   ▼
前端  web/  ──  办公室工位 + 实时活动日志
```

- **传输用 SSE（非 WebSocket）**：服务→浏览器单向推送正好够用，Node 标准库原生支持，零安装摩擦。
- **数据源单用 hooks**：实测足够做精确的多 agent 归属，无需再去 tail transcript。

---

## 目录结构

```
CC可视化/
├─ server/
│  ├─ server.mjs     HTTP 采集 + SSE 推送 + 静态托管 + 演示端点
│  └─ state.mjs      hook 事件 → 可视化状态的归约逻辑（核心）
├─ web/
│  ├─ index.html     办公室 + 侧栏布局
│  ├─ app.js         SSE 订阅、顶栏/日志渲染、驱动 Office/Dialogue
│  ├─ sprites.js     像素 sprite 系统（章鱼帧数据 + 家具 + 调色板 + 调试画廊）
│  ├─ office.js      2D 办公室场景（布局、漫游 FSM、rAF 动画循环、详情卡）
│  ├─ dialogue.js    彩蛋对话（台词库 + 真实数据注入 + 成对闲聊）
│  └─ styles.css     面板视觉、气泡/名牌/详情卡样式
├─ hooks/
│  └─ hooks.json     标准 hook 配置（type:http，可直接参考 / 打包成插件）
├─ install.mjs       幂等地把 hooks 合并进 settings.json（支持 --project / --uninstall）
├─ experiment/       技术验证沙盒（payload 捕获 + 状态机冒烟测试）
├─ .claude/launch.json
└─ package.json
```

---

## 自定义

- **改端口**：`CC_VIZ_PORT=5000 node server/server.mjs`，安装时同步 `node install.mjs --port 5000`。
- **角色名 / 工具图标**：编辑 `web/app.js` 顶部的 `NAME` / `TOOL_IC` 映射，给你常用的 `subagent_type`（如 `Explore`、`Plan`、自定义 agent）配专属名称。
- **章鱼造型 / 动画**：`web/sprites.js` 里全是字符串像素矩阵（一字符一像素），改几个字符就能换造型；`?debug=sprites` 画廊实时预览。
- **台词库**：`web/dialogue.js` 顶部的 `WORK_BY_TOOL` / `ERROR_QUIPS` / `FACILITY_QUIPS` / `CHAT_PAIRS`,直接加中文台词即可,支持 `{tool}{file}{dur}{n}{err}{msg}` 占位符。
- **办公室布局**：`web/office.js` 顶部的 `FACILITIES` / `DECOR` / 工位常量,改坐标即可挪家具。
- **状态归约**：所有"事件→状态"逻辑集中在 `server/state.mjs`，要加字段（如 token 用量、错误高亮）改这里即可。

---

## 已实现的进阶能力

- **多会话楼层**：按 `session_id` 分会话、按 `cwd` 分楼层（左侧电梯导航），并发会话互不干扰；ended 会话 10 分钟后清理,上限 16 个按 LRU 淘汰（`server/state.mjs`）。
- **模型徽章**：每个 agent 名牌显示当前模型（如 `fable-5`、`haiku-4.5`），server 端从 transcript JSONL 尾部提取（`server/models.mjs`；子 agent transcript 在 `<session目录>/subagents/agent-<id>.jsonl`）。
- **储物架箱子**：工具调用涉及的目录化为货架纸箱,agent 换目录干活时会跑去搬对应箱子回工位,完工归还（`state.mjs` 的 `dirOf` + `office.js` 的 PICKING/还箱 FSM）。
- **驻场会话（可视化内直接发指令）**：左侧「➕ 新会话」在指定路径 spawn 长驻 `claude -p` stream-json 进程（`server/managed.mjs`），可选模型与权限模式;办公室下方对话条直接派发指令;空闲 30 分钟自动休眠,再次发送用 `--resume` 唤醒。终端里开的会话仍是只读观察（无法向交互式终端注入输入）。
- **权限审批卡**：驻场会话挂载 `--permission-prompt-tool`（`server/approve-mcp.mjs`,零依赖 stdio MCP）;claude 需要权限的操作（如 `git push`）会在办公室下方弹出红色审批卡,点「允许 / 本会话总是允许 / 拒绝」,决定经长轮询回传——CLI 的权限弹窗体验完整搬进可视化。
- **对话全文面板**：侧栏「💬 对话全文」按时间序显示你的指令与 assistant 完整回复（活动日志里只留 200 字摘要）,再也不会错过"需要你批准"这类关键信息。
- **稳定性**：崩溃堆栈落盘到 `%TEMP%\cc-viz-crash.log`;自管子进程 PID 记录在临时文件,server 重启时自动回收孤儿进程。

## 已知边界 / 下一步

- `Agent` 派活的 `tool_use_id` 与子 agent 的 `agent_id` 暂未强关联（按时序/父子层级展示，已够用）；如需精确连线，可读 `SubagentStop` 的 transcript 做匹配。
- 驻场会话休眠后用 `--resume` 唤醒会分叉出新 `session_id`（楼层里出现新房间继续对话,旧房间保留历史）。
- 路线图：① DAG / 时间线视图切换（信息密度更高）；② token / 耗时统计面板；③ 打包成 Claude Code 插件（`hooks/hooks.json` 已就绪，可直接放进插件的 `hooks/` 目录）。

---

## 服务未启动会影响我的会话吗？

不会。hook 是 `type:http`，服务没开时连接立即失败（localhost 拒绝连接是瞬时的），Claude Code 把它当作非阻塞错误忽略，你的会话照常进行。
