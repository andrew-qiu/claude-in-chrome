// popup: 连接状态 + 手动重连
document.getElementById("reconnect").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "popup_reconnect" }).catch(() => {});
  setTimeout(() => location.reload(), 300);
};

const s = await chrome.runtime.sendMessage({ type: "popup_status" }).catch(() => null);
const statusEl = document.getElementById("status");
const hostEl = document.getElementById("hostinfo");
if (s) {
  statusEl.textContent = s.connected ? "connected to bridge" : "not connected (retrying every 5s)";
  statusEl.className = s.connected ? "ok" : "bad";
  hostEl.textContent = `extension ${s.extensionId ?? ""} · ${s.userAgent?.slice(0, 60) ?? ""}`;
} else {
  statusEl.textContent = "background unreachable";
  statusEl.className = "bad";
}
