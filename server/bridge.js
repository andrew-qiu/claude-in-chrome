// TCP 桥：接收 host.exe 的反向连接，转发工具调用
// - 多会话并发：后启动的会话 evict 持有者（last-session-wins）；
//   被逐出的实例转休眠（MCP 保活，工具改报原因）
// - 心跳：pong 3 个周期未回即判定 host 已死并断开（host 侧 ≤3s 退避重连）

import net from "net";
import { encodeFrame, FrameDecoder, msg } from "../lib/protocol.js";
import { HOST, PORT, TOOL_TIMEOUT } from "./config.js";

const log = (...a) => console.error("[claude-in-chrome]", ...a);

let tcpServer = net.createServer();
let hostConn = null; // net.Socket
let hostInfo = null; // hello 信息
let dormant = null; // 非 null 表示本实例不持有 TCP 桥，值为原因
let evictAttempts = 0; // EADDRINUSE 后的逐出重试次数（listen 成功清零）
const pending = new Map(); // id -> {resolve, reject, timer}
let nextId = 1;
let pongsMissed = 0;

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
tcpServer.on("connection", (socket) => {
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
    tcpServer.close(); // close 后可重新 listen（/mcp 重连时由 wireServer 的重试路径接管）
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
        "claude-in-chrome extension loaded (chrome://extensions → Load unpacked → the " +
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

// 心跳：只发不查会让死连接一直显示 connected
setInterval(() => {
  if (hostConn && !hostConn.destroyed) {
    if (++pongsMissed >= 3) return dropHost("3 pings unanswered");
    sendToHost(msg.ping());
  }
}, 30000).unref();

function wireServer(srv) {
  srv.on("error", (e) => {
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
        `(likely an old claude-in-chrome server). Free the port or /mcp reconnect later.`;
      log(dormant);
      return;
    }
    log(`port ${PORT} busy; evicting holder (attempt ${evictAttempts})`);
    const sock = net.connect(PORT, HOST);
    sock.on("connect", () => sock.end(encodeFrame(msg.evict({ pid: process.pid }))));
    sock.on("error", () => {}); // 持有者可能恰好退出；close 统一兜底重试
    sock.on("close", () => {
      setTimeout(() => srv.listen(PORT, HOST), 120 + Math.random() * 180); // 抖动防两个新会话同步互踢
    });
  });
}
wireServer(tcpServer);

/** browser_status 的状态文案 */
function statusText() {
  if (dormant) return `not connected — ${dormant}`;
  if (hostConn) return `connected: ${JSON.stringify(hostInfo)}`;
  return (
    "not connected — waiting for host.exe (Windows Chrome with claude-in-chrome extension). " +
    "Run install.sh and reload the extension, then retry."
  );
}

export const bridge = { callTool, statusText };

tcpServer.listen(PORT, HOST, () => {
  evictAttempts = 0;
  log(`TCP bridge listening on ${HOST}:${PORT} (host.exe connects here)`);
});
