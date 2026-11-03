// claude-in-chrome 扩展 service worker（入口，type: module）
// 模块划分：
//   host-link.js  native messaging 连接（host.exe）+ 工具请求分发入口
//   tools.js      工具实现 + 站点允许清单门禁
//   cdp.js        chrome.debugger 会话管理 + console/network 缓冲
//   page.js       页面注入遍历（快照/ref 定位/按键）
//   indicator.js  Agent 活动指示器（pill/呼吸边框/幽灵光标）

import { send, reconnect } from "./host-link.js"; // 连接在 host-link 导入时建立
import { connState } from "./conn-state.js";

// 标签页 URL 变化通知（上游仅记日志，v2 可做自动快照等）
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" && connState.connected) {
    send({ type: "notification", event: "tab_loaded", data: { tabId } });
  }
});

// popup 消息
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "popup_status") {
    sendResponse({
      connected: connState.connected,
      extensionId: chrome.runtime.id,
      userAgent: navigator.userAgent,
    });
    return false;
  }
  if (msg?.type === "popup_reconnect") {
    reconnect();
    sendResponse({ ok: true });
    return false;
  }
});
