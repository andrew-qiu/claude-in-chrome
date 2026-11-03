// claude-in-chrome 扩展 service worker
// 上行: chrome.runtime.connectNative → host.exe → TCP → MCP server
// 下行: chrome.debugger (CDP) 控制标签页
//
// 协议帧（经 native messaging，每条 postMessage 即一帧）:
//   hello / ping / pong / tool_request{id,tool,args} / tool_response{id,ok,result|error}

const HOST_NAME = "com.user.claude_in_chrome";
const RECONNECT_MS = 5000;
const BUF_SIZE = 200; // console/network 环形缓冲条数
const NAV_TIMEOUT = 20000;

let port = null;
let portConnected = false;

// ---------------------------------------------------------------------------
// Native messaging 连接（带重连）
// ---------------------------------------------------------------------------
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
  portConnected = true;
  p.onMessage.addListener(onHostMessage);
  p.onDisconnect.addListener(() => {
    // popup_reconnect 会先 disconnect 旧 port 再建新连接；
    // 旧 port 的断连回调晚于新连接赋值，这里必须只清自己，否则会把新 port 打掉
    if (port !== p) return;
    portConnected = false;
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

function send(obj) {
  if (!portConnected || !port) return false;
  try {
    port.postMessage(obj);
    return true;
  } catch (e) {
    console.warn("postMessage failed:", e);
    return false;
  }
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

// ---------------------------------------------------------------------------
// 工具分发
// ---------------------------------------------------------------------------
async function dispatchTool(id, tool, args) {
  try {
    if (GATED.has(tool)) {
      // back/forward 不算新 URL，不做站点门禁。
      // 显式指定 tabId 时按目标 tab 的 URL 判定，而非活动 tab（后台 tab 会绕过/误伤）
      const url = tool === "navigate"
        ? (/^(back|forward)$/i.test(String(args?.url)) ? null : args?.url)
        : typeof args?.tabId === "number"
          ? await tabUrl(args.tabId)
          : await activeTabUrl();
      if (url && !(await siteAllowed(url))) {
        return {
          type: "tool_response",
          id,
          ok: false,
          error: `site not allowed by claude-in-chrome options: ${url} (open the extension options to allow it)`,
        };
      }
    }
    const h = TOOLS[tool];
    if (!h) throw new Error(`unknown tool: ${tool}`);
    const result = await h(args);
    return { type: "tool_response", id, ok: true, result };
  } catch (e) {
    return { type: "tool_response", id, ok: false, error: String(e?.message ?? e) };
  } finally {
    scheduleIndicatorHide(); // 工具结束后指示器停留片刻再淡出
  }
}

const wrap = (fn) => (args) => Promise.resolve(fn(args)).catch((e) => {
  throw new Error(e?.message ?? String(e));
});

// ---------------------------------------------------------------------------
// CDP 会话管理
// ---------------------------------------------------------------------------
const attached = new Set(); // tabId

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

// tabId → Map(frameId → contextId)；tabId → [{label, contextId, start, end}]（ref 区间）
const frameCtx = new Map();
const refRanges = new Map();

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
const consoleBuf = new Map();
const netBuf = new Map();

async function resolveTab(args) {
  if (typeof args.tabId === "number") {
    await ensureAttached(args.tabId);
    showIndicator(args.tabId);
    return args.tabId;
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .catch(() => []);
  const tab = tabs[0] ?? (await chrome.tabs.query({ active: true }))[0];
  if (!tab) throw new Error("no active tab; pass tabId from browser_tabs_list");
  await ensureAttached(tab.id);
  showIndicator(tab.id);
  return tab.id;
}

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

// ---------------------------------------------------------------------------
// Agent 活动指示器（复刻 Claude in Chrome 的 agent-visual-indicator）：
// 底部胶囊 pill + 橙色呼吸边框 + 幽灵光标，挂在 closed shadow root 里，
// 页面 CSS 无法影响，PAGE_WALK 也遍历不到（display:contents + 0x0 rect）。
// 经 Runtime.evaluate 注入，无需 scripting/host_permissions。
// ---------------------------------------------------------------------------
const INDICATOR_JS = `
(function(mode, x, y) {
  var host = document.getElementById('cb-agent-indicator');
  var root = host && host.__cbRoot;
  if (!root) {
    host = document.createElement('div');
    host.id = 'cb-agent-indicator';
    host.setAttribute('aria-hidden', 'true');
    root = host.attachShadow({ mode: 'closed' });
    host.__cbRoot = root;

    var style = document.createElement('style');
    style.textContent =
      '@keyframes cb-pulse{0%,100%{opacity:.6}50%{opacity:1}}' +
      '@media(prefers-reduced-motion:reduce){*{animation:none!important}}';
    root.appendChild(style);

    var glow = document.createElement('div');
    glow.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:2147483646;opacity:0;transition:opacity .3s ease-in-out';
    var glowInner = document.createElement('div');
    glowInner.style.cssText =
      'position:absolute;inset:0;box-shadow:inset 0 0 15px rgba(217,119,87,.7),inset 0 0 25px rgba(217,119,87,.5),inset 0 0 35px rgba(217,119,87,.2);animation:cb-pulse 2s ease-in-out infinite';
    glow.appendChild(glowInner);
    root.appendChild(glow);

    var pill = document.createElement('div');
    pill.style.cssText =
      'position:fixed;bottom:16px;left:50%;transform:translateX(-50%) translateY(10px);display:inline-flex;align-items:center;' +
      'padding:8px 16px;background:#FAF9F5;border:.5px solid rgba(31,30,29,.3);border-radius:14px;' +
      'box-shadow:0 40px 80px 0 rgba(0,0,0,.15);z-index:2147483647;pointer-events:none;white-space:nowrap;user-select:none;' +
      'font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#141413;' +
      'opacity:0;transition:opacity .3s,transform .3s';
    pill.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:16px;height:16px;flex-shrink:0"><path d="M3.13946 10.6399L6.28757 8.87462L6.37405 8.73821L6.28757 8.6339H6.13189L5.60432 8.6018L3.80541 8.55366L2.24865 8.48947L0.735135 8.40923H0.492973L0.354595 8.32899L0.181622 8.1685L0.0345946 8.01605L0 7.85557L0.0345946 7.62287L0.138378 7.44634L0.224865 7.40622H0.354595L0.812973 7.44634L1.82486 7.51856L3.34703 7.62287L4.44541 7.68706L6.08 7.85557H6.33946L6.37405 7.75125L6.28757 7.68706L6.21838 7.62287L4.64432 6.55567L2.94054 5.4323L2.04973 4.78235L1.57405 4.45336L1.33189 4.14845L1.22811 3.92377L1.17622 3.69107L1.22811 3.47442L1.33189 3.28185L1.46162 3.13741L1.66054 2.99298H1.87676L2.24865 3.0331L2.39568 3.07322L2.99243 3.53059L4.26378 4.51755L5.92432 5.73721L6.16649 5.93781H6.27892V5.82548L6.16649 5.64092L5.26703 4.01204L4.30703 2.35105L3.87459 1.66098L3.76216 1.25176C3.7391 1.16082 3.69297 0.977332 3.69297 0.970913V0.762287L3.77946 0.505517L3.93513 0.240722L4.18595 0.0882648L4.4627 0H4.67892L4.83459 0.0240722L5.12865 0.0882648L5.4054 0.328987L5.82054 1.27583L6.48649 2.76028L7.52432 4.78235L7.82703 5.38415L7.99135 5.93781L8.05189 6.10632H8.15567V6.01003L8.24216 4.87061L8.39784 3.47442L8.55351 1.67703L8.6054 1.17151L8.85622 0.561685L8.9773 0.417252L9.21946 0.232698H9.35784L9.74703 0.417252L9.97189 0.665998L10.067 0.874624L10.0238 1.17151L9.83351 2.40722L9.46162 4.34102L9.21946 5.64092H9.35784L9.52216 5.47242L10.1795 4.60582L11.2778 3.22568L11.7622 2.68004L12.333 2.07823L12.6962 1.78937L13.0162 1.67703L13.3881 1.78937L13.7168 2.06219L13.8897 2.54363V2.76028L13.6649 3.32197L12.9557 4.22066L12.3676 4.98295L12.0043 5.56871L11.0011 7.02106V7.08526H11.1741L13.0768 6.67603L14.1059 6.49147L15.3341 6.28285L15.5762 6.34704L15.8876 6.53962L15.9481 6.80441L15.8876 7.12538L15.7319 7.34203L14.4173 7.66299L12.8778 7.97593L10.5854 8.51559C10.5705 8.51909 10.56 8.53236 10.56 8.54764C10.56 8.56468 10.573 8.57891 10.59 8.58044L11.6238 8.67402L12.0649 8.69809H13.1459L15.1611 8.85055L15.6886 9.19559L15.9481 9.39619L16 9.62086L15.9481 9.94985L15.8443 10.1023L15.4119 10.3029L15.1351 10.3591L14.0454 10.1023L11.4941 9.49248L10.6205 9.27583H10.4995V9.34804L11.2259 10.0622L12.5665 11.2658L14.2357 12.8225L14.3222 13.0953V13.2076L14.1059 13.5125L13.9243 13.5206L13.8811 13.4804L12.4108 12.3731L12.2984 12.325L11.84 11.8756L10.56 10.7924H10.4735V10.9047L10.7676 11.338L12.333 13.6891L12.4108 14.4112L12.2984 14.6439L11.8919 14.7884L11.667 14.7563L11.4508 14.7081L11.2605 14.5396L10.5254 13.4162L9.5827 11.9719L8.82162 10.672H8.79342C8.76039 10.672 8.73278 10.6972 8.7297 10.73L8.27676 15.5667L8.06919 15.8154L7.6454 16H7.58486L7.17838 15.6951L6.96216 15.1976L7.17838 14.2106L7.43784 12.9268L7.6454 11.9077L7.83567 10.6399L7.95187 10.2164C7.9548 10.2057 7.95069 10.1944 7.94161 10.1881C7.91157 10.1672 7.87034 10.1741 7.84878 10.2037L6.89297 11.5145L5.44 13.4804L4.28973 14.7081L4.01297 14.8205H3.80541L3.5373 14.5717V14.4514L3.58054 14.1304L3.84865 13.7372L5.44 11.7151L6.4 10.4554L7.01872 9.73222C7.04511 9.70139 7.04245 9.65523 7.0127 9.62763C7.00333 9.61894 6.98925 9.61773 6.97854 9.62471L2.75027 12.3811L1.99784 12.4774L1.66919 12.1725L1.71243 11.675L1.86811 11.5145L3.13946 10.6399Z" fill="#D97757"/></svg>' +
      '<span style="margin-left:8px">Claude is active in this tab</span>' +
      '<span style="width:7px;height:7px;border-radius:50%;background:#D97757;margin-left:10px;animation:cb-pulse 2s ease-in-out infinite"></span>';
    root.appendChild(pill);

    var cursor = document.createElement('div');
    cursor.style.cssText =
      'position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;opacity:0;' +
      'transform:translate3d(' + (x || 0) + 'px,' + (y || 0) + 'px,0);' +
      'transition:opacity .2s,transform 180ms cubic-bezier(.2,0,0,1);will-change:transform';
    cursor.innerHTML =
      '<svg width="20" height="26" viewBox="0 0 20 26" style="overflow:visible;filter:drop-shadow(0 0 4px rgba(217,119,87,.9)) drop-shadow(0 0 10px rgba(217,119,87,.45))"><path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z" fill="#D97757" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    root.appendChild(cursor);

    (document.body || document.documentElement).appendChild(host);
    root.__pill = pill;
    root.__glow = glow;
    root.__cursor = cursor;
  }
  var pill = root.__pill, glow = root.__glow, cursor = root.__cursor;
  if (mode === 'show') {
    glow.style.opacity = '1';
    pill.style.opacity = '1';
    pill.style.transform = 'translateX(-50%) translateY(0)';
  } else if (mode === 'hide' || mode === 'hideNow') {
    glow.style.opacity = '0';
    pill.style.opacity = '0';
    pill.style.transform = 'translateX(-50%) translateY(10px)';
    cursor.style.opacity = '0';
    setTimeout(function() {
      if (pill.style.opacity === '0') host.remove();
    }, mode === 'hideNow' ? 0 : 350);
  } else if (mode === 'cursor') {
    cursor.style.opacity = '1';
    cursor.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  }
  return true;
})
`;

const indicatorShown = new Set(); // tabId（pill 当前可见）
const indicatorHideTimers = new Map(); // tabId → 淡出定时器

async function indicator(tabId, mode, x, y) {
  try {
    await evaluate(tabId, `${INDICATOR_JS}(${JSON.stringify(mode)}, ${Number(x) || 0}, ${Number(y) || 0})`);
  } catch {
    /* 指示器失败不影响工具本身 */
  }
}

function showIndicator(tabId) {
  clearTimeout(indicatorHideTimers.get(tabId));
  indicatorHideTimers.delete(tabId);
  indicatorShown.add(tabId);
  indicator(tabId, "show");
}

function scheduleIndicatorHide(delayMs = 2000) {
  for (const tabId of indicatorShown) {
    clearTimeout(indicatorHideTimers.get(tabId));
    indicatorHideTimers.set(tabId, setTimeout(() => {
      indicatorHideTimers.delete(tabId);
      if (indicatorShown.delete(tabId)) indicator(tabId, "hide");
    }, delayMs));
  }
}

// ---------------------------------------------------------------------------
// 页面注入脚本（快照与 ref 解析共用同一确定性遍历，保证 ref 编号一致）。
// 递归穿 shadow DOM；startRef 用于 iframe 场景的全局连续编号；
// focus/find 为独立模式；resolve 会把 frame 内坐标换算到顶层视口。
// ---------------------------------------------------------------------------
const PAGE_WALK = `
(function(mode, arg, maxElements, startRef) {
  const INTERACTIVE = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="textbox"],[role="checkbox"],[role="switch"],[role="combobox"],[role="option"],[role="slider"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"]),summary,details,label[for]';
  const BLOCKISH = 'h1,h2,h3,h4,h5,h6,p,li,td,th,pre,code,blockquote,img,svg,canvas,video,audio,iframe';
  const SENSITIVE = /password|cc-number|cc-csc|cc-exp|otp|one-time-code|security-code|new-password|current-password/i;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const labelOf = (el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.type === 'hidden') return '';
      const lbl = el.labels?.[0]?.innerText || el.placeholder || el.getAttribute('aria-label') || el.name || '';
      const redact = el.type === 'password' || SENSITIVE.test(el.getAttribute('autocomplete') || '');
      const val = redact ? '[value redacted]' : (el.value ?? '');
      return (lbl ? lbl + ': ' : '') + '[' + (el.tagName.toLowerCase()) + (el.type && el.tagName === 'INPUT' ? ' ' + el.type : '') + ' value=' + JSON.stringify(String(val).slice(0,80)) + ']';
    }
    return '';
  };
  // 深度优先递归遍历，穿 shadow root（官方 a11y 树天然覆盖，这里等效补齐）
  function* walk(root) {
    for (const el of root.children) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
    }
  }
  let nextRef = startRef || 0;
  const takeNextRef = () => ++nextRef;
  if (mode === 'resolve' || mode === 'focus' || mode === 'scrollTo') {
    for (const node of walk(document.body)) {
      if (!visible(node)) continue;
      if (!node.matches(INTERACTIVE)) continue;
      if (takeNextRef() === arg) {
        if (mode === 'focus') {
          node.focus();
          if (node.value !== undefined) { node.selectionStart = node.selectionEnd = node.value.length; }
          return { found: true, tag: node.tagName.toLowerCase() };
        }
        if (mode === 'scrollTo') {
          node.scrollIntoView({ block: 'center' });
          return { found: true, tag: node.tagName.toLowerCase() };
        }
        const r = node.getBoundingClientRect();
        let cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        // frame 内坐标换算到顶层视口；跨源 frame 拿不到 frameElement
        let crossOrigin = false;
        for (let w = window; w !== w.top; w = w.parent) {
          const fe = w.frameElement;
          if (!fe) { crossOrigin = true; break; }
          const b = fe.getBoundingClientRect();
          cx += b.x; cy += b.y;
        }
        return crossOrigin
          ? { found: true, tag: node.tagName.toLowerCase(), crossOriginFrame: true }
          : { found: true, cx, cy, x: r.x, y: r.y, w: r.width, h: r.height, tag: node.tagName.toLowerCase() };
      }
    }
    return { found: false };
  }
  if (mode === 'find') {
    const q = String(arg || '').toLowerCase();
    const out = [];
    for (const el of walk(document.body)) {
      if (out.length >= (maxElements || 20)) break;
      if (el.matches('script,style,noscript,link,meta')) continue;
      if (!visible(el)) continue;
      // 编号规则必须与 resolve/snapshot 一致：所有可见交互元素依次取号
      // （无论是否匹配），否则 find 返回的 ref 与 click 的 resolve 错位
      const inter = el.matches(INTERACTIVE);
      const ref = inter ? takeNextRef() : undefined;
      // 敏感输入框的 value 不进搜索文本（同 labelOf 的脱敏）
      const redact = el instanceof HTMLInputElement && (el.type === 'password' || SENSITIVE.test(el.getAttribute('autocomplete') || ''));
      const hay = [el.innerText, el.id, el.getAttribute('aria-label'), el.name, el.placeholder, redact ? null : el.value, el.getAttribute('title')]
        .filter((x) => typeof x === 'string').join(' ').toLowerCase();
      if (!q || !hay.includes(q)) continue;
      if (!inter && !el.matches(BLOCKISH)) continue;
      out.push({ ref, tag: el.tagName.toLowerCase(), text: (hay || '').slice(0, 120) });
    }
    return { matches: out, refCount: nextRef };
  }
  // snapshot 模式：同样的可见+可交互判定编号，保证与 resolve 一致
  const emit = (el, kind) => {
    const desc = { tag: el.tagName.toLowerCase() };
    if (kind === 'interactive') desc.ref = takeNextRef();
    const txt = (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    if (txt) desc.text = txt;
    const lbl = labelOf(el);
    if (lbl) desc.text = (lbl + ' ' + (txt || '')).trim();
    if (el.id) desc.id = el.id;
    if (kind === 'img') desc.src = (el.currentSrc || el.src || '').slice(0, 200);
    return desc;
  };
  const out = [];
  for (const el of walk(document.body)) {
    if (out.length >= maxElements) break;
    if (el.matches('script,style,noscript,link,meta')) continue;
    if (!visible(el)) continue;
    if (el.matches(INTERACTIVE)) out.push(emit(el, 'interactive'));
    else if (el.matches(BLOCKISH)) {
      // 只在"叶子块"输出文本，避免父块重复
      const hasElChild = Array.from(el.children).some((c) => c.matches(BLOCKISH + ',' + INTERACTIVE) && visible(c));
      if (!hasElChild) out.push(emit(el, el.tagName === 'IMG' || el.tagName === 'SVG' || el.tagName === 'IFRAME' ? 'img' : 'text'));
    }
  }
  return { url: location.href, title: document.title, scrollY: Math.round(scrollY), elements: out, refCount: nextRef };
})
`;

async function pageWalk(tabId, mode, arg, maxElements = 400, startRef = 0, contextId) {
  const expr = `${PAGE_WALK}(${JSON.stringify(mode)}, ${JSON.stringify(arg)}, ${maxElements}, ${startRef})`;
  try {
    return await evaluate(tabId, expr, { contextId });
  } catch (e) {
    if (contextId !== undefined && /context/i.test(String(e?.message ?? ""))) {
      throw new Error("frame context gone — page changed; take a new browser_snapshot");
    }
    throw e;
  }
}

// 按 ref 找到对应 frame 上下文后执行指定模式（resolve/focus/scrollTo）
async function pageWalkRef(tabId, mode, ref) {
  const ranges = refRanges.get(tabId);
  const r = ranges?.find((x) => ref >= x.start && ref <= x.end);
  if (r && r.contextId) return pageWalk(tabId, mode, ref, 0, r.start - 1, r.contextId);
  return pageWalk(tabId, mode, ref);
}

// 统一目标定位：ref（经 frame 区间）/ selector / 显式坐标 → 视口坐标 + rect
async function locateTarget(tabId, a) {
  if (typeof a.ref === "number") {
    const r = await pageWalkRef(tabId, "resolve", a.ref);
    if (!r.found) throw new Error(`ref ${a.ref} not found — page may have changed; take a new browser_snapshot`);
    if (r.crossOriginFrame) {
      throw new Error("ref is inside a cross-origin iframe: coordinate actions unsupported — use browser_type (focus-based) or browser_js");
    }
    return r;
  }
  if (a.selector) {
    const r = await evaluate(
      tabId,
      `(() => { const el = document.querySelector(${JSON.stringify(a.selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return { found: true, cx: b.x + b.width/2, cy: b.y + b.height/2, x: b.x, y: b.y, w: b.width, h: b.height, tag: el.tagName.toLowerCase() }; })()`
    );
    if (!r?.found) throw new Error(`selector not found: ${a.selector}`);
    return r;
  }
  if (typeof a.x === "number" && typeof a.y === "number") {
    return { found: true, cx: a.x, cy: a.y, x: a.x, y: a.y, tag: "coordinates" };
  }
  throw new Error("pass ref (from browser_snapshot), selector, or x/y coordinates");
}

// 聚焦输入目标（ref 在 frame 里也能 focus——不经坐标，跨源 iframe 可用）
async function focusTarget(tabId, a) {
  if (typeof a.ref === "number") {
    const f = await pageWalkRef(tabId, "focus", a.ref);
    if (!f.found) throw new Error(`ref ${a.ref} not found — take a new browser_snapshot`);
    return;
  }
  if (a.selector) {
    const ok = await evaluate(
      tabId,
      `(() => { const el = document.querySelector(${JSON.stringify(a.selector)}); if (!el) return false; el.focus(); if (el.value) { el.selectionStart = el.selectionEnd = el.value.length; } return true; })()`
    );
    if (!ok) throw new Error(`selector not found: ${a.selector}`);
    return;
  }
  throw new Error("pass ref (from browser_snapshot) or selector");
}

// 按键/组合键（"Enter"、"Control+a"、"ArrowDown"）
const MOD_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
const KEY_VK = {
  enter: 13, tab: 9, escape: 27, esc: 27, backspace: 8, delete: 46, del: 46, space: 32,
  arrowleft: 37, arrowup: 38, arrowright: 39, arrowdown: 40,
  home: 36, end: 35, pageup: 33, pagedown: 34,
  f1: 112, f2: 113, f3: 114, f4: 115, f5: 116, f6: 117, f7: 118, f8: 119, f9: 120, f10: 121, f11: 122, f12: 123,
};

async function pressKey(tabId, combo) {
  const parts = String(combo).split("+").map((s) => s.trim()).filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error(`bad key combo: ${combo}`);
  let modifiers = 0;
  for (const m of parts) {
    const bit = MOD_BITS[m.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier: ${m} (use Ctrl/Alt/Shift/Meta)`);
    modifiers |= bit;
  }
  const k = key.length === 1 ? key : key[0].toUpperCase() + key.slice(1).toLowerCase();
  const vk = KEY_VK[key.toLowerCase()] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  const code = /^[a-z]$/i.test(k) ? "Key" + k.toUpperCase() : /^[0-9]$/.test(k) ? "Digit" + k : k;
  const ev = {
    modifiers,
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    ...(modifiers === 0 && k.length === 1 ? { text: k, unmodifiedText: k } : {}),
  };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...ev });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...ev });
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------
const TOOLS = {
  status: wrap(async () => ({
    connected: portConnected,
    extensionId: chrome.runtime.id,
    userAgent: navigator.userAgent,
    attachedTabs: [...attached],
  })),

  tabs_list: wrap(async () => {
    const tabs = await chrome.tabs.query({});
    const groupNames = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, `${g.title ?? ""}#${g.color ?? ""}`]));
    return tabs.map((t) => ({
      tabId: t.id,
      title: (t.title ?? "").slice(0, 120),
      url: t.url ?? "",
      active: t.active,
      windowId: t.windowId,
      ...(t.groupId != null && t.groupId !== -1
        ? { groupId: t.groupId, group: groupNames.get(t.groupId) ?? "unknown" }
        : {}),
    }));
  }),

  tab_new: wrap(async (a) => {
    const t = await chrome.tabs.create({ url: a.url ?? "about:blank", active: true });
    // 官方模式：agent 开的 tab 归入橙色 Claude 组，与人开的 tab 区分。
    // 注意 chrome.tabs.group() 返回数字 groupId（不是 {id}）。
    let groupWarning;
    try {
      const groups = await chrome.tabGroups.query({ title: "Claude", windowId: t.windowId });
      if (groups[0]) {
        await chrome.tabs.group({ tabIds: [t.id], groupId: groups[0].id });
      } else {
        const gid = await chrome.tabs.group({ tabIds: [t.id], createProperties: { windowId: t.windowId } });
        await chrome.tabGroups.update(gid, { title: "Claude", color: "orange" });
      }
    } catch (e) { groupWarning = String(e?.message ?? e); }
    return { tabId: t.id, ...(groupWarning ? { groupWarning } : {}) };
  }),

  tab_close: wrap(async (a) => {
    await chrome.tabs.remove(a.tabId);
    attached.delete(a.tabId);
    consoleBuf.delete(a.tabId);
    netBuf.delete(a.tabId);
    clearTimeout(indicatorHideTimers.get(a.tabId));
    indicatorHideTimers.delete(a.tabId);
    indicatorShown.delete(a.tabId);
    return { closed: a.tabId };
  }),

  navigate: wrap(async (a) => {
    const tabId = await resolveTab(a);
    const loaded = new Promise((res) => {
      const timer = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(h);
        res("timeout");
      }, NAV_TIMEOUT);
      const h = (src, method) => {
        if (src.tabId === tabId && method === "Page.loadEventFired") {
          clearTimeout(timer);
          chrome.debugger.onEvent.removeListener(h);
          res("loaded");
        }
      };
      chrome.debugger.onEvent.addListener(h);
    });
    if (/^(back|forward)$/i.test(String(a.url))) {
      // 历史导航（官方支持 back/forward）
      const hist = await cdp(tabId, "Page.getNavigationHistory");
      const delta = String(a.url).toLowerCase() === "back" ? -1 : 1;
      const entry = hist.entries[hist.currentIndex + delta];
      if (!entry) return { ...(await evaluate(tabId, "({url: location.href, title: document.title})")), loadState: "no-history" };
      await cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
    } else {
      await cdp(tabId, "Page.navigate", { url: a.url });
    }
    const state = await loaded;
    await new Promise((r) => setTimeout(r, 500)); // 等首帧渲染
    const info = await evaluate(tabId, "({url: location.href, title: document.title})");
    return { ...info, loadState: state };
  }),

  snapshot: wrap(async (a) => {
    const tabId = await resolveTab(a);
    const max = a.maxElements ?? 400;
    const main = await pageWalk(tabId, "snapshot", null, max);
    let refCount = main.refCount;
    const ranges = [{ label: null, contextId: null, start: 1, end: main.refCount }];
    // iframe 覆盖：各 frame 的默认执行上下文里跑同一遍历，ref 全局连续编号
    try {
      const tree = await cdp(tabId, "Page.getFrameTree");
      const ctxs = frameCtx.get(tabId);
      const frames = [];
      (function collect(node) {
        for (const c of node.childFrames ?? []) { frames.push(c.frame); collect(c); }
      })(tree.frameTree);
      for (const f of frames.slice(0, 5)) {
        if (main.elements.length >= max) break;
        const ctx = ctxs?.get(f.id);
        if (!ctx) continue;
        const fs = await pageWalk(tabId, "snapshot", null, Math.min(150, max - main.elements.length), refCount, ctx);
        if (!fs?.elements?.length) continue;
        let label = f.url;
        try { label = new URL(f.url).hostname || f.url; } catch {}
        fs.elements.forEach((e) => { e.frame = label; });
        main.elements.push(...fs.elements);
        ranges.push({ label, contextId: ctx, start: refCount + 1, end: fs.refCount });
        refCount = fs.refCount;
      }
    } catch { /* frame 遍历失败不影响主帧快照 */ }
    refRanges.set(tabId, ranges);
    main.frames = ranges.filter((r) => r.label).map((r) => ({ frame: r.label, refs: `${r.start}-${r.end}` }));
    return main;
  }),

  get_text: wrap(async (a) => {
    const tabId = await resolveTab(a);
    const expr = a.selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(a.selector)}); return el ? el.innerText : null; })()`
      : "document.body.innerText";
    const text = (await evaluate(tabId, expr)) ?? "";
    return { text: String(text).slice(0, 20000), truncated: text.length > 20000 };
  }),

  click: wrap(async (a) => {
    const tabId = await resolveTab(a);
    const target = await locateTarget(tabId, a);
    const act = a.action ?? "left";
    // 真实事件：先移幽灵光标并派发 mouseMoved（触发 hover 态），再按动作点击
    await indicator(tabId, "cursor", target.cx, target.cy);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: target.cx, y: target.cy, button: "none" });
    if (act === "hover") {
      await new Promise((r) => setTimeout(r, 300));
      return { hovered: true, tag: target.tag, url: await evaluate(tabId, "location.href") };
    }
    const before = Date.now();
    const clicks = act === "double" ? 2 : act === "triple" ? 3 : 1;
    const button = act === "right" ? "right" : "left";
    for (let i = 0; i < clicks; i++) {
      const common = { x: target.cx, y: target.cy, button, clickCount: i + 1 };
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...common });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
      if (i < clicks - 1) await new Promise((r) => setTimeout(r, 60));
    }
    await new Promise((r) => setTimeout(r, 400));
    // 官方行为：点击弹出新 tab 时把新 tabId 告诉模型
    const opened = recentCreated.find((t) => t.opener === tabId && t.ts >= before);
    return {
      clicked: true,
      tag: target.tag,
      action: act,
      ...(opened ? { newTabId: opened.id } : {}),
      url: await evaluate(tabId, "location.href"),
    };
  }),

  type: wrap(async (a) => {
    const tabId = await resolveTab(a);
    await focusTarget(tabId, a);
    await new Promise((r2) => setTimeout(r2, 150));
    // 全选后输入，覆盖已有内容
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await cdp(tabId, "Input.insertText", { text: String(a.text) });
    if (a.submit) {
      await pressKey(tabId, "Enter");
      await new Promise((r2) => setTimeout(r2, 800));
    }
    return { typed: true, url: await evaluate(tabId, "location.href") };
  }),

  screenshot: wrap(async (a) => {
    const tabId = await resolveTab(a);
    await indicator(tabId, "hideNow"); // 指示器不拍进截图（官方同样做法）
    let format = a.format === "jpeg" ? "jpeg" : "png";
    const params = { format, fromSurface: true };
    if (format === "jpeg") params.quality = Math.max(1, Math.min(100, a.quality ?? 75));
    let clip = null;
    if (a.ref !== undefined || a.selector) {
      // 区域截图 / 放大（官方 zoom：png + clip + scale）
      const t = await locateTarget(tabId, a);
      clip = { x: Math.max(0, t.x ?? t.cx - 200), y: Math.max(0, t.y ?? t.cy - 150), width: t.w ?? 400, height: t.h ?? 300, scale: Math.max(1, Math.min(4, Number(a.scale) || 1)) };
      format = params.format = "png";
      delete params.quality;
      params.clip = clip;
    } else if (a.fullPage) {
      const m0 = await cdp(tabId, "Page.getLayoutMetrics");
      const cs = m0?.cssContentSize ?? {};
      params.captureBeyondViewport = true;
      clip = { x: 0, y: 0, width: cs.width ?? 0, height: cs.height ?? 0, scale: 1 };
      params.clip = clip;
    }
    let r = await cdp(tabId, "Page.captureScreenshot", params);
    // JPEG 自适应降质（官方 MAX_BASE64_CHARS 同款阈值）
    if (format === "jpeg") {
      for (const q of [50, 30]) {
        if (r.data.length <= 1398100) break;
        params.quality = q;
        r = await cdp(tabId, "Page.captureScreenshot", params);
      }
    }
    const m = await cdp(tabId, "Page.getLayoutMetrics");
    const vp = m?.cssVisualViewport ?? {};
    return {
      base64: r.data,
      format,
      width: clip ? Math.round(clip.width * clip.scale) : Math.round(vp.clientWidth ?? 0),
      height: clip ? Math.round(clip.height * clip.scale) : Math.round(vp.clientHeight ?? 0),
    };
  }),

  js: wrap(async (a) => {
    const tabId = await resolveTab(a);
    // REPL 语义：顶层 await + 末表达式返回（复刻官方 javascript_exec）
    const expr = `(async () => { const __r = await eval(${JSON.stringify(a.expression)}); return __r; })()`;
    const v = await evaluate(tabId, expr, { awaitPromise: true });
    const s = v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return { content: [{ type: "text", text: String(s).slice(0, 50000) }] };
  }),

  console: wrap(async (a) => {
    const tabId = await resolveTab(a);
    let list = consoleBuf.get(tabId) ?? [];
    if (a.level && a.level !== "all") list = list.filter((x) => x.level === a.level);
    if (a.pattern) list = list.filter((x) => x.text.includes(a.pattern));
    const limit = a.limit ?? 50;
    return { messages: list.slice(-limit) };
  }),

  network: wrap(async (a) => {
    const tabId = await resolveTab(a);
    let list = netBuf.get(tabId) ?? [];
    if (a.pattern) list = list.filter((x) => x.url.includes(a.pattern));
    const limit = a.limit ?? 50;
    const matched = list.slice(-limit);
    if (a.body) {
      // 就地抓响应体（Network.getResponseBody；限 5 条防超时，body 已释放属正常）
      for (const it of matched.slice(-5)) {
        if (!it.done || it.failed) continue;
        try {
          const b = await cdp(tabId, "Network.getResponseBody", { requestId: it.requestId });
          if (b?.body) {
            it.body = b.base64Encoded
              ? new TextDecoder().decode(Uint8Array.from(atob(b.body), (c) => c.charCodeAt(0))).slice(0, 10000)
              : b.body.slice(0, 10000);
          }
        } catch {}
      }
    }
    return {
      requests: matched.map(({ requestId, ts, requestHeaders, responseHeaders, ...rest }) => ({
        ...rest,
        ...(a.detail ? { requestHeaders, responseHeaders } : {}),
      })),
    };
  }),

  key: wrap(async (a) => {
    const tabId = await resolveTab(a);
    await pressKey(tabId, a.key);
    await new Promise((r) => setTimeout(r, 150));
    return { pressed: a.key, url: await evaluate(tabId, "location.href") };
  }),

  hover: wrap(async (a) => {
    const tabId = await resolveTab(a);
    const t = await locateTarget(tabId, a);
    await indicator(tabId, "cursor", t.cx, t.cy);
    // 渐进移动触发依赖 mousemove 的悬停菜单
    for (let i = 1; i <= 3; i++) {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        button: "none",
        x: t.cx + ((t.w ?? 0) * (i - 2)) / 6,
        y: t.cy + ((t.h ?? 0) * (i - 2)) / 6,
      });
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 250));
    return { hovered: true, tag: t.tag };
  }),

  scroll: wrap(async (a) => {
    const tabId = await resolveTab(a);
    if (a.ref !== undefined || a.selector) {
      const f = typeof a.ref === "number"
        ? await pageWalkRef(tabId, "scrollTo", a.ref)
        : await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(a.selector)}); if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })()`);
      if (f !== true && !f?.found) throw new Error("scroll target not found — take a new browser_snapshot");
      await new Promise((r) => setTimeout(r, 300));
      return { scrolled: true, scrollY: await evaluate(tabId, "Math.round(scrollY)") };
    }
    const dy = (a.direction === "up" ? -1 : 1) * (a.amount ?? 600);
    const m = await cdp(tabId, "Page.getLayoutMetrics");
    const vp = m?.cssVisualViewport ?? {};
    const x = vp.clientWidth / 2, y = vp.clientHeight / 2;
    await indicator(tabId, "cursor", x, y);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: a.dx ?? 0, deltaY: dy });
    await new Promise((r) => setTimeout(r, 250));
    return { scrolled: true, scrollY: await evaluate(tabId, "Math.round(scrollY)") };
  }),

  drag: wrap(async (a) => {
    const tabId = await resolveTab(a);
    const from = a.fromX !== undefined && a.fromY !== undefined
      ? { cx: a.fromX, cy: a.fromY }
      : await locateTarget(tabId, { ref: a.fromRef, selector: a.fromSelector });
    const to = a.toX !== undefined && a.toY !== undefined
      ? { cx: a.toX, cy: a.toY }
      : await locateTarget(tabId, { ref: a.toRef, selector: a.toSelector });
    await indicator(tabId, "cursor", from.cx, from.cy);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: from.cx, y: from.cy, button: "left", clickCount: 1 });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: from.cx, y: from.cy, button: "left", clickCount: 1 });
    const steps = Math.max(2, Math.min(20, a.steps ?? 10));
    for (let i = 1; i <= steps; i++) {
      await cdp(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        button: "left",
        clickCount: 1,
        x: from.cx + ((to.cx - from.cx) * i) / steps,
        y: from.cy + ((to.cy - from.cy) * i) / steps,
      });
      await new Promise((r) => setTimeout(r, 16));
    }
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: to.cx, y: to.cy, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 250));
    return { dragged: true, url: await evaluate(tabId, "location.href") };
  }),

  wait: wrap(async (a) => {
    const tabId = await resolveTab(a);
    if (a.ms) {
      const ms = Math.min(30000, a.ms);
      await new Promise((r) => setTimeout(r, ms));
      return { waitedMs: ms };
    }
    if (!a.selector) throw new Error("pass selector (+state/timeoutMs) or ms");
    const state = a.state ?? "visible";
    const timeout = a.timeoutMs ?? 5000;
    const start = Date.now();
    let last;
    while (Date.now() - start < timeout) {
      last = await evaluate(tabId, `(() => { const el = document.querySelector(${JSON.stringify(a.selector)}); if (!el) return "none"; const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return (r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none") ? "visible" : "hidden"; })()`);
      // 元素被移除（none）视作满足 hidden——等"消失"不该因 DOM 删节点而超时
      if (last === state || (state === "hidden" && last === "none")) {
        return { selector: a.selector, state, waitedMs: Date.now() - start };
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`timeout after ${timeout}ms waiting for ${a.selector} to be ${state} (last state: ${last})`);
  }),

  form_input: wrap(async (a) => {
    const tabId = await resolveTab(a);
    const fields = a.fields ?? [];
    if (!fields.length) throw new Error("fields[] required: [{ref|selector, value}]");
    for (const f of fields) {
      await focusTarget(tabId, f);
      await new Promise((r) => setTimeout(r, 100));
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
      await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
      await cdp(tabId, "Input.insertText", { text: String(f.value) });
    }
    if (a.submit) {
      await pressKey(tabId, "Enter");
      await new Promise((r) => setTimeout(r, 800));
    }
    return { filled: fields.length, ...(a.submit ? { submitted: true } : {}), url: await evaluate(tabId, "location.href") };
  }),

  find: wrap(async (a) => {
    const tabId = await resolveTab(a);
    const q = String(a.query ?? "");
    const res = await pageWalk(tabId, "find", q, a.limit ?? 20);
    return { query: q, ...res };
  }),

  resize_window: wrap(async (a) => {
    const win = await chrome.windows.update(a.windowId ?? chrome.windows.WINDOW_ID_CURRENT, {
      ...(a.width ? { width: Math.round(a.width) } : {}),
      ...(a.height ? { height: Math.round(a.height) } : {}),
    });
    return { windowId: win.id, width: win.width, height: win.height };
  }),

  upload: wrap(async (a) => {
    const tabId = await resolveTab(a);
    if (!a.base64 || !a.name) throw new Error("name and base64 required (keep under ~600KB — native messaging frame limit)");
    let get;
    if (a.selector) {
      get = `document.querySelector(${JSON.stringify(a.selector)})`;
    } else if (typeof a.ref === "number") {
      const t = await locateTarget(tabId, a);
      get = `document.elementFromPoint(${t.cx}, ${t.cy})`;
    } else {
      throw new Error("pass ref or selector of a file input");
    }
    const payload = JSON.stringify({ name: a.name, mime: a.mimeType ?? "application/octet-stream", b64: a.base64 });
    const ok = await evaluate(tabId, `(() => {
      const d = ${payload};
      const el = ${get};
      if (!el || !(el instanceof HTMLInputElement) || el.type !== "file") return { ok: false, reason: "target is not a file input" };
      const bin = atob(d.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], d.name, { type: d.mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, size: bytes.length };
    })()`);
    if (!ok?.ok) throw new Error(ok?.reason ?? "upload failed");
    return { uploaded: a.name, size: ok.size };
  }),
};

// ---------------------------------------------------------------------------
// 站点允许清单（options 页配置；默认 * 允许全部——本机自用场景）
// ---------------------------------------------------------------------------
async function siteAllowed(url) {
  const { allowedSites } = await chrome.storage.local.get({ allowedSites: ["*"] });
  if (allowedSites.includes("*")) return true;
  try {
    const u = new URL(url);
    const host = u.hostname;
    // 规则可带端口（如 localhost:3000，options 页文档明示支持）；不带端口的规则按域名匹配
    const hostPort = host + (u.port ? ":" + u.port : "");
    return allowedSites.some((pat) =>
      host === pat || hostPort === pat || host.endsWith("." + pat) ||
      new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(host)
    );
  } catch {
    return false;
  }
}

// 工具调用前的站点门禁（仅对会改变页面状态的工具生效）
const GATED = new Set(["navigate", "click", "type", "js", "key", "hover", "drag", "scroll", "form_input", "upload"]);

async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ?? null;
  } catch {
    return null;
  }
}

async function tabUrl(tabId) {
  try {
    return (await chrome.tabs.get(tabId))?.url ?? null;
  } catch {
    return null;
  }
}

// 标签页 URL 变化通知（上游仅记日志，v2 可做自动快照等）
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "complete" && portConnected) {
    send({ type: "notification", event: "tab_loaded", data: { tabId } });
  }
});

// 新开 tab 记录（click 感知弹出新 tab 用，官方同款能力）
const recentCreated = [];
chrome.tabs.onCreated.addListener((t) => {
  recentCreated.push({ id: t.id, opener: t.openerTabId, ts: Date.now() });
  if (recentCreated.length > 20) recentCreated.shift();
});

// popup 消息
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "popup_status") {
    sendResponse({
      connected: portConnected,
      extensionId: chrome.runtime.id,
      userAgent: navigator.userAgent,
    });
    return false;
  }
  if (msg?.type === "popup_reconnect") {
    if (port) {
      try { port.disconnect(); } catch {}
      portConnected = false;
      port = null;
    }
    connectToHost();
    sendResponse({ ok: true });
    return false;
  }
});

connectToHost();
