// 工具实现：host 下发的 tool_request 在此分发。
// 含站点允许清单门禁（GATED 工具在调用前校验目标 URL）。

import { attached, consoleBuf, netBuf, frameCtx, refRanges, ensureAttached, cdp, evaluate, forgetTab as forgetCdpTab } from "./cdp.js";
import { indicator, showIndicator, scheduleIndicatorHide, forgetTab as forgetIndicatorTab } from "./indicator.js";
import { pageWalk, pageWalkRef, locateTarget, focusTarget, pressKey } from "./page.js";
import { connState } from "./conn-state.js";

const NAV_TIMEOUT = 20000;

const wrap = (fn) => (args) => Promise.resolve(fn(args)).catch((e) => {
  throw new Error(e?.message ?? String(e));
});

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

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------
const TOOLS = {
  status: wrap(async () => ({
    connected: connState.connected,
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
    forgetCdpTab(a.tabId);
    forgetIndicatorTab(a.tabId);
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

// 新开 tab 记录（click 感知弹出新 tab 用，官方同款能力）
const recentCreated = [];
chrome.tabs.onCreated.addListener((t) => {
  recentCreated.push({ id: t.id, opener: t.openerTabId, ts: Date.now() });
  if (recentCreated.length > 20) recentCreated.shift();
});

// ---------------------------------------------------------------------------
// 分发：host 的 tool_request → 门禁校验 → TOOLS 执行 → tool_response
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

export { dispatchTool };
