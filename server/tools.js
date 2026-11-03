// 工具面：对模型暴露的 browser_* 工具清单（schema 与描述）
// handler 在扩展端实现（extension/tools.js），这里只负责 MCP tools/list 与参数校验。

export const TOOLS = [
  {
    name: "browser_status",
    description:
      "Check claude-in-chrome connection status: whether the browser extension is connected, " +
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
