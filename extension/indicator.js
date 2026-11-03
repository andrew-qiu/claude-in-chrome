// Agent 活动指示器（复刻 Claude in Chrome 的 agent-visual-indicator）：
// 底部胶囊 pill + 橙色呼吸边框 + 幽灵光标，挂在 closed shadow root 里，
// 页面 CSS 无法影响，PAGE_WALK 也遍历不到（display:contents + 0x0 rect）。
// 经 Runtime.evaluate 注入，无需 scripting/host_permissions。

import { evaluate } from "./cdp.js";

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

/** tab 关闭时清理定时器与可见集合 */
function forgetTab(tabId) {
  clearTimeout(indicatorHideTimers.get(tabId));
  indicatorHideTimers.delete(tabId);
  indicatorShown.delete(tabId);
}

export { indicator, showIndicator, scheduleIndicatorHide, forgetTab };
