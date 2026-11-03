// CDP 会话管理：attach/断连重挂/命令发送 + debugger 事件路由
// （console/network 环形缓冲、各 frame 执行上下文、ref 区间）

const BUF_SIZE = 200; // console/network 环形缓冲条数

const attached = new Set(); // tabId
// tabId → Map(frameId → contextId)；tabId → [{label, contextId, start, end}]（ref 区间）
const frameCtx = new Map();
const refRanges = new Map();
const consoleBuf = new Map();
const netBuf = new Map();

// chrome:// 等受保护页面不能 attach（官方同样拒绝，报 chrome_protected_page）
async function assertAttachable(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  const url = t?.url ?? t?.pendingUrl ?? "";
  if (/^(chrome|edge|devtools|chrome-extension|view-source|about):/i.test(url) && ! /^(about:blank)$/i.test(url)) {
    throw new Error(`chrome_protected_page: cannot attach to ${url} — navigate the tab to a regular page first`);
  }
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  await assertAttachable(tabId);
  await new Promise((res, rej) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) rej(new Error(`debugger.attach: ${err.message}`));
      else res();
    });
  });
  attached.add(tabId);
  await rawCdp(tabId, "Runtime.enable");
  await rawCdp(tabId, "Page.enable");
  await rawCdp(tabId, "Network.enable", { maxPostDataSize: 65536 });
  // 后台标签页不失焦即可被控制/截图（官方 ensureFocusEmulation）
  await rawCdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
}

chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));

function rawCdp(tabId, method, params) {
  return new Promise((res, rej) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (r) => {
      const err = chrome.runtime.lastError;
      if (err) rej(new Error(`${method}: ${err.message}`));
      else res(r);
    });
  });
}

// 断连自动重挂后重试一次（官方 sendCommandWithReattach）
async function cdp(tabId, method, params) {
  try {
    return await rawCdp(tabId, method, params);
  } catch (e) {
    if (!/attach/i.test(String(e?.message ?? ""))) throw e;
    attached.delete(tabId);
    await ensureAttached(tabId);
    return rawCdp(tabId, method, params);
  }
}

function fmtRemote(a) {
  if (a?.type === "string") return a.value;
  if (a?.value !== undefined) return String(a.value);
  if (a?.description) return a.description;
  return a?.type ?? "";
}

function pushBuf(map, tabId, item) {
  let list = map.get(tabId);
  if (!list) map.set(tabId, (list = []));
  list.push(item);
  if (list.length > BUF_SIZE) list.splice(0, list.length - BUF_SIZE);
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method === "Runtime.consoleAPICalled") {
    pushBuf(consoleBuf, src.tabId, {
      ts: params.timestamp,
      level: params.type,
      text: (params.args ?? []).map(fmtRemote).join(" "),
    });
  } else if (method === "Runtime.exceptionThrown") {
    // 未捕获异常也进 console 缓冲（官方 read_console_messages 覆盖）
    const d = params.exceptionDetails ?? {};
    pushBuf(consoleBuf, src.tabId, {
      ts: params.timestamp,
      level: "error",
      text: d.exception?.description ?? d.text ?? "uncaught exception",
      uncaught: true,
    });
  } else if (method === "Page.javascriptDialogOpening") {
    // alert/confirm/beforeunload 自动接受，避免自动化卡死（官方按策略处理）
    pushBuf(consoleBuf, src.tabId, {
      ts: Date.now() / 1000,
      level: "info",
      text: `js dialog auto-accepted (${params.type}): ${params.message ?? ""}`.slice(0, 200),
    });
    cdp(src.tabId, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  } else if (method === "Network.requestWillBeSent") {
    pushBuf(netBuf, src.tabId, {
      requestId: params.requestId,
      method: params.request.method,
      url: params.request.url,
      type: params.type,
      ts: params.timestamp,
      requestHeaders: params.request.headers,
      postData: params.request.postData?.slice(0, 1024),
    });
  } else if (method === "Network.responseReceived") {
    const list = netBuf.get(src.tabId);
    const it = list?.find((x) => x.requestId === params.requestId);
    if (it) {
      it.status = params.response.status;
      it.mime = params.response.mimeType;
      it.responseHeaders = params.response.headers;
    }
  } else if (method === "Network.loadingFinished") {
    const list = netBuf.get(src.tabId);
    const it = list?.find((x) => x.requestId === params.requestId);
    if (it) {
      it.durationMs = Math.round((params.timestamp - it.ts) * 1000);
      it.size = params.encodedDataLength;
      it.done = true;
    }
  } else if (method === "Network.loadingFailed") {
    const list = netBuf.get(src.tabId);
    const it = list?.find((x) => x.requestId === params.requestId);
    if (it) {
      it.failed = params.errorText;
      it.done = true;
    }
  } else if (method === "Runtime.executionContextCreated") {
    // 各 frame 的默认执行上下文（iframe 快照/输入用）
    const aux = params.context?.auxData;
    if (aux?.frameId && aux.isDefault !== false) {
      let m = frameCtx.get(src.tabId);
      if (!m) frameCtx.set(src.tabId, (m = new Map()));
      m.set(aux.frameId, params.context.id);
    }
  } else if (method === "Runtime.executionContextDestroyed") {
    const m = frameCtx.get(src.tabId);
    if (m) for (const [k, v] of m) if (v === params.executionContextId) m.delete(k);
  } else if (method === "Runtime.executionContextsCleared") {
    frameCtx.delete(src.tabId);
    refRanges.delete(src.tabId);
  }
});

async function evaluate(tabId, expression, { awaitPromise = false, contextId } = {}) {
  const r = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    ...(contextId !== undefined ? { contextId } : {}),
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description ?? d.text ?? "evaluation failed");
  }
  return r.result?.value;
}

/** tab 关闭时清理本模块持有的全部状态 */
function forgetTab(tabId) {
  attached.delete(tabId);
  consoleBuf.delete(tabId);
  netBuf.delete(tabId);
  frameCtx.delete(tabId);
  refRanges.delete(tabId);
}

export {
  attached, consoleBuf, netBuf, frameCtx, refRanges,
  ensureAttached, cdp, evaluate, forgetTab,
};
