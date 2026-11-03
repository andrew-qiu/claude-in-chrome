// 页面注入脚本：快照与 ref 解析共用同一确定性遍历，保证 ref 编号一致。
// 递归穿 shadow DOM；startRef 用于 iframe 场景的全局连续编号；
// focus/find 为独立模式；resolve 会把 frame 内坐标换算到顶层视口。

import { cdp, evaluate, refRanges } from "./cdp.js";

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

export { pageWalk, pageWalkRef, locateTarget, focusTarget, pressKey };
