#!/usr/bin/env node
// claude-in-chrome MCP 服务器（入口）
// - stdio: 对 Claude Code 讲 MCP（JSON-RPC 2.0）           → stdio.js
// - TCP HOST:PORT: 接收 host.exe 的反向连接（WSL 需 localhostForwarding）→ bridge.js
// - 工具清单（tools/list schema）                          → tools.js
// - 运行配置（环境变量）                                    → config.js
//
// 环境变量（旧名 CHROME_BRIDGE_* 仍回退支持，方便存量部署平滑升级）:
//   CLAUDE_IN_CHROME_HOST  TCP 监听地址（默认 127.0.0.1；镜像网络模式下可用 0.0.0.0）
//   CLAUDE_IN_CHROME_PORT  TCP 端口（默认 8765）
//   CLAUDE_IN_CHROME_TOOL_TIMEOUT_MS  工具调用超时（默认 90000，同官方 browser_batch）

import { bridge } from "./bridge.js";
import { startStdio } from "./stdio.js";

startStdio(bridge);
