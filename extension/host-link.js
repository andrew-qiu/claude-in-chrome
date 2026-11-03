// Native messaging 连接（带重连）
// 上行: chrome.runtime.connectNative → host.exe → TCP → MCP server
// 协议帧（经 native messaging，每条 postMessage 即一帧）:
//   hello / ping / pong / tool_request{id,tool,args} / tool_response{id,ok,result|error}

import { dispatchTool } from "./tools.js";
import { connState } from "./conn-state.js";

const HOST_NAME = "com.user.claude_in_chrome";
const RECONNECT_MS = 5000;

let port = null;

export function send(obj) {
  if (!connState.connected || !port) return false;
  try {
    port.postMessage(obj);
    return true;
  } catch (e) {
    console.warn("postMessage failed:", e);
    return false;
  }
}

function connectToHost() {
  let p;
  try {
    p = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.warn("connectNative failed:", e);
    scheduleReconnect();
    return;
  }
  port = p;
  connState.connected = true;
  p.onMessage.addListener(onHostMessage);
  p.onDisconnect.addListener(() => {
    // popup_reconnect 会先 disconnect 旧 port 再建新连接；
    // 旧 port 的断连回调晚于新连接赋值，这里必须只清自己，否则会把新 port 打掉
    if (port !== p) return;
    connState.connected = false;
    port = null;
    const err = chrome.runtime.lastError?.message ?? "unknown";
    console.warn("native host disconnected:", err);
    scheduleReconnect();
  });
  send({
    type: "hello",
    client: "extension",
    extensionId: chrome.runtime.id,
    userAgent: navigator.userAgent,
    version: chrome.runtime.getManifest().version,
  });
}

function scheduleReconnect() {
  setTimeout(connectToHost, RECONNECT_MS);
}

async function onHostMessage(msg) {
  switch (msg.type) {
    case "hello":
      console.log("host hello:", msg);
      break;
    case "ping":
      send({ type: "pong", ts: msg.ts, now: Date.now() });
      break;
    case "tool_request":
      send(await dispatchTool(msg.id, msg.tool, msg.args ?? {}));
      break;
    default:
      send({ type: "error", error: `unknown message type: ${msg.type}` });
  }
}

/** popup 的 Reconnect 按钮：断开旧连接立即重连 */
export function reconnect() {
  if (port) {
    try { port.disconnect(); } catch {}
    connState.connected = false;
    port = null;
  }
  connectToHost();
}

connectToHost();
