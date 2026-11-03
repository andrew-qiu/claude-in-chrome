#!/usr/bin/env node
// chrome-bridge MCP 服务器
// - stdio: 对 Claude Code 讲 MCP（JSON-RPC 2.0）
// - TCP 127.0.0.1:8765: 接收 Windows host.exe 的反向连接（WSL localhostForwarding）
//
// 环境变量:
//   CHROME_BRIDGE_HOST  TCP 监听地址（默认 127.0.0.1；镜像网络模式下可用 0.0.0.0）
//   CHROME_BRIDGE_PORT  TCP 端口（默认 8765）
//   CHROME_BRIDGE_TOOL_TIMEOUT_MS  工具调用超时（默认 90000，同官方 browser_batch）

import net from "net";
import { encodeFrame, FrameDecoder, msg } from "../lib/protocol.js";

const HOST = process.env.CHROME_BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.CHROME_BRIDGE_PORT ?? 8765);
const TOOL_TIMEOUT = Number(process.env.CHROME_BRIDGE_TOOL_TIMEOUT_MS ?? 90000);
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "chrome-bridge", version: "0.3.0" };

const log = (...a) => console.error("[chrome-bridge]", ...a);

// ---------------------------------------------------------------------------
// 工具面（对模型暴露）
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "browser_status",
    description:
      "Check chrome-bridge connection status: whether the browser extension is connected, " +
      "which browser/user agent it reports, and host version. Call this first when browser " +
      "tools fail or before starting a browser workflow.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_navigate",
    description: "Navigate the active tab (or a given tab) to a URL and wait for load. Also accepts \"back\"/\"forward\" for history navigation.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL, or \"back\"/\"forward\"" },
        tabId: { type: "number", description: "Optional tab id from browser_tabs_list; defaults to active tab" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_tabs_list",
    description: "List open browser tabs: id, title, url, active state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_tab_new",
    description: "Open a new tab, optionally at a URL, and activate it.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "browser_tab_close",
    description: "Close a tab by id.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_snapshot",
    description:
      "Capture a DOM snapshot of the current page: a pruned element tree with roles, text and " +
      "numbered refs ([ref]) for interactive elements (links, buttons, inputs, selects). " +
      "Use the ref numbers with browser_click / browser_type. Pair with browser_screenshot for visuals.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "number" },
        maxElements: { type: "number", description: "Cap on reported elements, default 400" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_get_text",
    description: "Extract the visible text content of the current page (or a CSS selector scope).",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_click",
    description: 'Click an element by snapshot ref number, CSS selector, or x/y coordinates. Supports left (default), right, double, triple clicks and hover.',
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "number", description: "Ref number from browser_snapshot" },
        selector: { type: "string", description: "CSS selector (used when ref is absent)" },
        x: { type: "number", description: "Viewport x coordinate (with y)" },
        y: { type: "number", description: "Viewport y coordinate (with x)" },
        action: { type: "string", enum: ["left", "right", "double", "triple", "hover"], description: "Default left" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_type",
    description:
      "Type text into an input identified by snapshot ref or CSS selector; optionally press Enter to submit.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "number" },
        selector: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        tabId: { type: "number" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Screenshot the current page: viewport by default, full page with fullPage, or a zoomed region " +
      "with ref/selector (+scale up to 4). JPEG shrinks payload via adaptive quality.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpeg"], description: "Default png" },
        quality: { type: "number", description: "JPEG quality 1-100, default 75" },
        fullPage: { type: "boolean", description: "Capture beyond the viewport" },
        ref: { type: "number", description: "Clip to this element (from browser_snapshot)" },
        selector: { type: "string", description: "Clip to this CSS selector" },
        scale: { type: "number", description: "Zoom scale 1-4 when clipping (png only)" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_js",
    description:
      "Execute JavaScript in the current page context with REPL semantics: top-level await works, " +
      "the value of the last expression is returned (write the expression, not `return ...`). " +
      "Example: `location.href` or `await fetch('/api/x').then(r=>r.json())`.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_console",
    description:
      "Read buffered console messages from the current page, including uncaught exceptions. " +
      "Ask for a pattern or level rather than everything when logs are verbose.",
    inputSchema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["error", "warning", "info", "log", "debug", "all"], description: "Default all" },
        pattern: { type: "string", description: "Substring filter" },
        limit: { type: "number", description: "Default 50" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_network",
    description:
      "Read buffered network requests (method, url, status, type, duration, size) for the current page. " +
      "detail:true adds headers+postData; body:true fetches up to 5 response bodies.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "URL substring filter" },
        limit: { type: "number", description: "Default 50" },
        detail: { type: "boolean", description: "Include request/response headers and postData" },
        body: { type: "boolean", description: "Fetch response bodies (last 5 matched)" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_key",
    description: "Press a key or combo in the page, e.g. \"Enter\", \"Escape\", \"Control+a\", \"ArrowDown\", \"Tab\".",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name or Ctrl/Alt/Shift/Meta combo joined with +" },
        tabId: { type: "number" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_hover",
    description: "Hover over an element (dispatch mouseMoved events; triggers hover menus).",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "number" },
        selector: { type: "string" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_scroll",
    description:
      "Scroll the page: by wheel (direction up/down + amount px, default 600), horizontally (dx), or scroll an element into view (ref/selector).",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number", description: "Pixels per wheel tick, default 600" },
        dx: { type: "number", description: "Horizontal pixels (either sign)" },
        ref: { type: "number", description: "Scroll this element into view (overrides wheel)" },
        selector: { type: "string", description: "Scroll this selector into view" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_drag",
    description: "Drag from one element/point to another (ref/selector or fromX/fromY → toRef/toSelector or toX/toY).",
    inputSchema: {
      type: "object",
      properties: {
        fromRef: { type: "number" },
        fromSelector: { type: "string" },
        fromX: { type: "number" },
        fromY: { type: "number" },
        toRef: { type: "number" },
        toSelector: { type: "string" },
        toX: { type: "number" },
        toY: { type: "number" },
        steps: { type: "number", description: "Interpolation steps 2-20, default 10" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_wait",
    description:
      "Wait for an element to become visible/hidden (selector + state, default visible, timeoutMs default 5000), or sleep ms.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        state: { type: "string", enum: ["visible", "hidden"] },
        timeoutMs: { type: "number" },
        ms: { type: "number", description: "Plain sleep (max 30000)" },
        tabId: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_form_input",
    description: "Fill multiple form fields in one call: fields: [{ref|selector, value}]; optionally submit (Enter) after.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "number" },
              selector: { type: "string" },
              value: { type: "string" },
            },
            required: ["value"],
          },
        },
        submit: { type: "boolean" },
        tabId: { type: "number" },
      },
      required: ["fields"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_find",
    description:
      "Find elements by text/id/label/name/value substring — lighter than a full snapshot when hunting one element. Returns matches with refs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Case-insensitive substring" },
        limit: { type: "number", description: "Default 20" },
        tabId: { type: "number" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "browser_resize_window",
    description: "Resize the browser window (width/height in pixels).",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
        windowId: { type: "number", description: "Defaults to current window" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "browser_upload",
    description:
      "Upload an in-memory file to a file input: base64 + name (+mimeType), targeted by ref/selector. Keep under ~600KB.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "number" },
        selector: { type: "string" },
        name: { type: "string", description: "File name, e.g. report.csv" },
        mimeType: { type: "string", description: "Default application/octet-stream" },
        base64: { type: "string" },
        tabId: { type: "number" },
      },
      required: ["name", "base64"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// host 连接管理
// ---------------------------------------------------------------------------
let hostConn = null; // net.Socket
let hostInfo = null; // hello 信息
let dormant = null; // 非 null 表示本实例不持有 TCP 桥（被新会话接管 / 逐出失败），值为原因
let evictAttempts = 0; // EADDRINUSE 后的逐出重试次数（listen 成功清零）
const pending = new Map(); // id -> {resolve, reject, timer}
let nextId = 1;

function dropHost(reason) {
  if (!hostConn) return;
  log("host disconnected:", reason);
  hostConn.destroy();
  hostConn = null;
  hostInfo = null;
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(`connection lost: ${reason}`));
    pending.delete(id);
  }
}

// 连接角色判定：host.exe 连上先发 hello；evict 是同机新会话的接管请求，不能当 host 收。
const tcpServer = net.createServer((socket) => {
  let role = null; // "host" | "control" | null（首帧未到）
  const decoder = new FrameDecoder();
  socket.on("data", (chunk) => {
    let frames;
    try {
      frames = decoder.feed(chunk);
    } catch (e) {
      socket.destroy();
      if (role === "host") dropHost(`bad frame: ${e.message}`);
      return;
    }
    for (const f of frames) {
      if (!role) {
        if (f.type === "hello") {
          role = "host";
          if (hostConn) {
            log("second host connection; dropping old one");
            dropHost("replaced");
          }
          hostConn = socket;
          hostInfo = f;
          pongsMissed = 0;
          log(`host connected: ${f.client ?? "?"} v${f.version ?? "?"} pid=${f.pid ?? "?"} from ${socket.remoteAddress}`);
          continue;
        }
        if (f.type === "evict") {
          role = "control";
          handleEvict(f);
          socket.end();
          return;
        }
        socket.destroy(); // 首帧不是 hello/evict：不是我们的客户端
        return;
      }
      if (role === "host") handleFrame(f);
    }
  });
  socket.on("error", (e) => {
    if (role === "host") dropHost(e.message);
  });
  socket.on("close", () => {
    if (role === "host") dropHost("closed");
  });
});

// 被新会话逐出：释放 TCP 桥但保活 MCP（本会话工具转为报错说明，而非 CONNECTION_CLOSED）
function handleEvict(f) {
  log(`evicted by newer session pid=${f.pid ?? "?"}; going dormant (MCP stays up)`);
  dormant =
    `taken over by a newer Claude Code session (pid ${f.pid ?? "?"}) at ` +
    `${new Date().toLocaleTimeString()} — this session keeps running but has no browser ` +
    `control; run /mcp reconnect here to reclaim`;
  try {
    tcpServer.close();
  } catch {}
  if (hostConn) dropHost("evicted by newer session");
}

function handleFrame(f) {
  switch (f.type) {
    case "pong":
      pongsMissed = 0;
      break;
    case "tool_response": {
      const p = pending.get(f.id);
      if (!p) return;
      pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.ok) p.resolve(f.result);
      else p.reject(new Error(f.error ?? "tool failed"));
      break;
    }
    case "notification":
      log("notification:", f.event, JSON.stringify(f.data)?.slice(0, 200));
      break;
    case "ping":
      sendToHost(msg.pong(f.ts));
      break;
    default:
      log("unknown frame type:", f.type);
  }
}

function sendToHost(obj) {
  if (!hostConn || hostConn.destroyed) return false;
  try {
    hostConn.write(encodeFrame(obj));
    return true;
  } catch {
    return false;
  }
}

async function callTool(tool, args) {
  if (dormant) throw new Error(`bridge not held by this session — ${dormant}`);
  if (!hostConn || hostConn.destroyed) {
    throw new Error(
      "Browser extension is not connected. Ensure Chrome is running with the " +
        "chrome-bridge extension loaded (chrome://extensions → Load unpacked → the " +
        "deployed extension dir shown by install.sh) and that install.sh finished. Then retry browser_status."
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`tool ${tool} timed out after ${TOOL_TIMEOUT}ms`));
    }, TOOL_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    if (!sendToHost(msg.toolRequest(id, tool.replace(/^browser_/, ""), args))) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("Browser extension is not connected."));
    }
  });
}

// 心跳：检测半开连接（pong 3 个周期未回即判定 host 已死并断开；
// host 侧 ≤3s 退避自动重连。只发不查会让死连接一直显示 connected）
let pongsMissed = 0;
setInterval(() => {
  if (hostConn && !hostConn.destroyed) {
    if (++pongsMissed >= 3) return dropHost("3 pings unanswered");
    sendToHost(msg.ping());
  }
}, 30000).unref();

// ---------------------------------------------------------------------------
// MCP stdio（JSON-RPC 2.0）
// ---------------------------------------------------------------------------
function rpcResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

const ERR = { tool: -32000, parse: -32700, method: -32601 };

async function handleRpc(req) {
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
        const text = dormant
          ? `not connected — ${dormant}`
          : hostConn
            ? `connected: ${JSON.stringify(hostInfo)}`
            : "not connected — waiting for host.exe (Windows Chrome with chrome-bridge extension). " +
              "Run install.sh and reload the extension, then retry.";
        return rpcResult(id, { content: [{ type: "text", text }] });
      }
      const spec = TOOLS.find((t) => t.name === name);
      if (!spec) return rpcError(id, ERR.method, `unknown tool: ${name}`);
      try {
        const result = await callTool(name, args);
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

// stdio 循环：按行读 JSON-RPC
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
    handleRpc(req)
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

tcpServer.listen(PORT, HOST, () => {
  evictAttempts = 0;
  log(`TCP bridge listening on ${HOST}:${PORT} (host.exe connects here)`);
  log(`MCP server ready on stdio; ${TOOLS.length} tools`);
});
tcpServer.on("error", (e) => {
  if (e.code !== "EADDRINUSE") {
    log("TCP server error:", e.message);
    process.exit(1);
  }
  // 端口被占：逐出持有者，最后启动的会话胜出（多会话并发场景）。
  // 注意：旧版本持有者不认识 evict（会把我们误当 host 且不放端口），
  // 重试上限后转休眠——保住 MCP 连接，工具改报原因，不再 exit(1)。
  evictAttempts++;
  if (evictAttempts > 20) {
    dormant =
      `port ${PORT} is held by another process that did not yield to eviction ` +
      `(likely an old chrome-bridge server). Free the port or /mcp reconnect later.`;
    log(dormant);
    return;
  }
  log(`port ${PORT} busy; evicting holder (attempt ${evictAttempts})`);
  const sock = net.connect(PORT, HOST);
  sock.on("connect", () => sock.end(encodeFrame(msg.evict({ pid: process.pid }))));
  sock.on("error", () => {}); // 持有者可能恰好退出；close 统一兜底重试
  sock.on("close", () => {
    setTimeout(() => tcpServer.listen(PORT, HOST), 120 + Math.random() * 180); // 抖动防两个新会话同步互踢
  });
});
