# claude-in-chrome

Claude Code 官方的 `/chrome` 浏览器操作能力绑定第一方模型：一旦把 Claude Code 接到
第三方模型（GLM、任意 OpenAI-compatible 端点、Bedrock 等），`/chrome` 就用不了了。

本项目补上这个缺口——一个**开源平替**：不挑模型、不需要 Anthropic 账号、不需要
`--remote-debugging-port`，让任何模型驱动的 Claude Code 会话都能直接操作浏览器。
官方能力的大部分都已覆盖：页面导航、DOM 快照、点击/输入、截图、JS 执行、控制台与
网络观测、标签页管理（agent 开的标签页自动归入橙色 "Claude" 组）。

最关键的一点：它控制的是你**日常正在用的那个 Chrome**——默认 profile、登录态、
已开的标签页全部保留，而不是另起一个干净的自动化浏览器。

> 独立第三方项目，与 Anthropic 无关联、未获其认可。"Claude" 是 Anthropic 的商标，
> 在此仅作兼容性说明使用。

## 工作原理

```
Claude Code（任意模型） ──stdio MCP──▶ server/（Claude Code 所在机器，Node）
                                          ▲ TCP 127.0.0.1:8765
                                          │   （仅 WSL 部署需 localhostForwarding）
                              native host（bun 编译单文件）
                                          ▲ Chrome Native Messaging
                                          │
                       extension/（MV3，chrome.debugger 控制标签页）
                                          │
                                  你的日常 Chrome
```

MCP server 跑在 **Claude Code 所在的机器**上，native host 跑在 **Chrome 所在的机器**上，
二者 TCP 相连。四层转发架构（扩展 ↔ host ↔ TCP ↔ MCP server）参考了 Claude Code
官方 `/chrome` 的公开行为与协议设计。

## 安装（执行一次）

```bash
bash install.sh
```

自动检测平台，全平台同一入口：

| 环境 | host 目标 | 部署目录 | NM 注册方式 |
|---|---|---|---|
| WSL（→Windows Chrome） | bun-windows-x64 | `C:\Users\<你>\claude-in-chrome\` | 注册表（`WIN_USER` 可覆盖，默认自动探测） |
| 纯 Windows（Git Bash） | bun-windows-x64 | `%USERPROFILE%\claude-in-chrome\` | 注册表 |
| 纯 Linux | bun-linux-x64/arm64 | `~/.local/share/claude-in-chrome/` | `~/.config/google-chrome/NativeMessagingHosts/`（chromium 目录存在时同写） |
| 纯 macOS | bun-darwin-x64/arm64 | `~/.local/share/claude-in-chrome/` | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` |

脚本会：装 bun → 按平台编译 host → 部署 host + extension → 计算 unpacked 扩展 ID
（Windows 路径 UTF-16LE / POSIX 路径 UTF-8）→ 写 Native Messaging manifest →
注册 MCP server 到 `~/.claude.json` → 端到端自测（端口被活会话持有时自动跳过，
不会打断正在运行的桥）。从旧版 `chrome-bridge` 升级时自动迁移（旧注册表键、
旧 manifest、旧 MCP 注册名会被清理；环境变量旧名 `CHROME_BRIDGE_*` 仍回退支持）。

特殊场景：`CLAUDE_IN_CHROME_FORCE_OS=<wsl|linux|macos|windows>` 强制平台；
`CLAUDE_IN_CHROME_PORT` 换端口；`CHROME_EXT_ID` 显式指定扩展 ID。

随后手动（一次性）：

1. Chrome 打开 `chrome://extensions`
2. 右上角开启「开发者模式」→「加载已解压的扩展程序」→ 选安装输出里显示的 extension 目录
3. 完全退出并重启 Chrome
4. 重启 Claude Code 会话，调用 `browser_status` 验证连接

## 工具面（22 个）

| 工具 | 说明 |
|---|---|
| `browser_status` | 连接状态（排障第一步） |
| `browser_navigate` | 导航当前/指定标签页 |
| `browser_tabs_list` / `browser_tab_new` / `browser_tab_close` | 标签页管理 |
| `browser_snapshot` | DOM 快照：元素树 + 可交互元素 `[ref]` 编号 |
| `browser_get_text` | 提取页面可见文本 |
| `browser_click` / `browser_type` | 按 ref 或 CSS 选择器点击/输入（真实事件） |
| `browser_screenshot` | PNG 截图（返回图像内容） |
| `browser_js` | 页面内执行 JS，REPL 语义（顶层 await + 末表达式返回） |
| `browser_console` / `browser_network` | 控制台日志 / 网络请求缓冲 |

站点允许清单：扩展 options 页配置，默认 `*`（全部允许）。

## 典型用法（对 Claude 说）

```
打开 localhost:3000，提交带非法数据的表单，看错误提示是否正确显示
```
```
browser_snapshot 之后点击 [3]，在 [5] 里输入 "hooks" 回车，告诉我结果
```

## 排障

- **工具报 "not connected"**：Chrome 是否在跑、扩展是否加载（`chrome://extensions`）、
  host.log（`C:\Users\<你>\claude-in-chrome\host.log`）；点扩展图标 → Reconnect。
- **localhost 转发失效**（自测失败）：`CLAUDE_IN_CHROME_FORCE_WSL_IP=1 bash install.sh`，
  host.exe 会改连 WSL eth0 IP。
- **扩展 ID 与 manifest 不符**：`browser_status` 返回实际 extensionId，把它填进
  `com.user.claude_in_chrome.json` 的 `allowed_origins`（`chrome-extension://<ID>/`）。
- 每次改扩展代码后：重新 `install.sh`（会重新拷贝）+ 在 `chrome://extensions` 点刷新。
  注意 Windows 侧 `host.exe` 正在运行时会被文件锁挡住——先退出 Chrome 再重装。
- **纯 Linux/macOS 排障**：host 日志在部署目录 `host.log`；确认 manifest 里的
  `path` 指向 `claude-in-chrome-host` 包装脚本且有执行位。
- **多会话并发**：TCP 桥（8765）独占，后启动的会话自动接管（last-session-wins）——
  新实例向持有者发 `evict` 帧，持有者释放端口、断开 host.exe（≤3s 退避自动重连新持有者）
  并转休眠。休眠会话的 MCP 仍在线，`browser_status` 报被接管原因（pid + 时间），
  在那边 `/mcp` 重连即可夺回。持有者若是不认识 `evict` 的旧版 server，新会话重试 20 次
  （约 5s）后转休眠而不是退出。

## 开发

```bash
node --test test/          # 协议 + 多会话接管单测
node tools/gen-icon.mjs    # 重新生成扩展图标（extension/icons/，零依赖）
bun build --compile --target=bun-windows-x64 host/host.ts --outfile host/host.exe
```
