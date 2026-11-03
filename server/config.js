// 运行配置：环境变量 → 默认值
// 旧名 CHROME_BRIDGE_* 回退支持，方便存量部署平滑升级。

export const HOST =
  process.env.CLAUDE_IN_CHROME_HOST ?? process.env.CHROME_BRIDGE_HOST ?? "127.0.0.1";

export const PORT =
  Number(process.env.CLAUDE_IN_CHROME_PORT ?? process.env.CHROME_BRIDGE_PORT ?? 8765);

export const TOOL_TIMEOUT = Number(
  process.env.CLAUDE_IN_CHROME_TOOL_TIMEOUT_MS ??
    process.env.CHROME_BRIDGE_TOOL_TIMEOUT_MS ?? 90000,
);

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "claude-in-chrome", version: "0.3.0" };
