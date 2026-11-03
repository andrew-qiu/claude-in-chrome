// MCP stdio：按行读 JSON-RPC 2.0，把 tools/call 转发到 TCP 桥

import { TOOLS } from "./tools.js";
import { PROTOCOL_VERSION, SERVER_INFO } from "./config.js";

const log = (...a) => console.error("[claude-in-chrome]", ...a);

function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

const ERR = { tool: -32000, parse: -32700, method: -32601 };

async function handleRpc(req, bridge) {
  const { id, method, params } = req;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return null; // 通知无响应
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === "browser_status") {
        return rpcResult(id, { content: [{ type: "text", text: bridge.statusText() }] });
      }
      const spec = TOOLS.find((t) => t.name === name);
      if (!spec) return rpcError(id, ERR.method, `unknown tool: ${name}`);
      try {
        const result = await bridge.callTool(name, args);
        const content = formatResult(name, result);
        return rpcResult(id, { content, isError: false });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: `error: ${e.message}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, ERR.method, `method not found: ${method}`);
  }
}

function formatResult(name, result) {
  if (name === "browser_screenshot" && typeof result?.base64 === "string") {
    return [
      { type: "image", data: result.base64, mimeType: result.format === "jpeg" ? "image/jpeg" : "image/png" },
      { type: "text", text: `screenshot ${result.width ?? "?"}x${result.height ?? "?"}` },
    ];
  }
  if (result?.content) return result.content; // 扩展返回的通用 {content:[...]}
  return [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }];
}

export function startStdio(bridge) {
  let stdinBuf = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    stdinBuf += chunk;
    let nl;
    while ((nl = stdinBuf.indexOf("\n")) !== -1) {
      const line = stdinBuf.slice(0, nl).trim();
      stdinBuf = stdinBuf.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        process.stdout.write(rpcError(null, ERR.parse, "parse error") + "\n");
        continue;
      }
      handleRpc(req, bridge)
        .then((resp) => {
          if (resp !== null) process.stdout.write(resp + "\n");
        })
        .catch((e) => {
          if (req.id !== undefined) {
            process.stdout.write(rpcError(req.id, ERR.tool, e.message) + "\n");
          }
        });
    }
  });
  process.stdin.on("end", () => {
    log("stdio closed; exiting");
    process.exit(0);
  });
}
