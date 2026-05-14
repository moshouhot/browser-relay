#!/usr/bin/env node
/**
 * MCP stdio server for browser-relay (no-auth).
 *
 * Exposes high-level browser tools over the Model Context Protocol.
 * Each tool maps to an HTTP call to the relay-server.
 *
 * Works with any MCP-compatible agent (Claude Code, Claude Desktop,
 * Cursor, Windsurf, etc.)
 *
 * Usage:
 *   BROWSER_RELAY_URL=http://127.0.0.1:18795 node mcp-server.js
 */
import { readFileSync } from "node:fs";

const RELAY_URL = (process.env.BROWSER_RELAY_URL || "http://127.0.0.1:18795").replace(/\/$/, "");
const RELAY_PORT = parseInt(new URL(RELAY_URL).port || "18795", 10);
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;

// ---------------------------------------------------------------------------
// HTTP client to relay
// ---------------------------------------------------------------------------
async function relayRequest(method, path, body) {
  const url = `${RELAY_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  const opts = { method, headers };
  if (body !== undefined && method !== "GET") opts.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const message = `Cannot reach Browser Relay at ${RELAY_URL}: ${detail}`;
    throw relayToolError(errorPayload("relay_unreachable", message, { status: 0, retryable: true }));
  }

  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }

  if (!res.ok) {
    const payload = data && typeof data === "object"
      ? data
      : errorPayload("http_error", `HTTP ${res.status}`, { status: res.status });
    throw relayToolError(payload);
  }
  if (data?.ok === false) throw relayToolError(data);
  return data;
}

async function relayGet(path) { return relayRequest("GET", path); }
async function relayPost(path, body) { return relayRequest("POST", path, body); }

function addQueryParam(params, name, value) {
  if (value !== undefined && value !== null && value !== "") params.set(name, String(value));
}

const LOCATOR_SCHEMA = {
  type: "object",
  properties: {
    selector: { type: "string", description: "CSS selector to narrow or find the element" },
    text: { type: "string", description: "Visible text to match" },
    role: { type: "string", description: "Approximate ARIA or implicit role, e.g. button, link, textbox" },
    name: { type: "string", description: "Approximate accessible name, aria-label, placeholder, title, value, or text" },
    exact: { type: "boolean", description: "Require exact text/name match instead of substring match" },
  },
};

function errorPayload(code, message, options = {}) {
  return {
    ok: false,
    code,
    error: message,
    message,
    status: options.status ?? 500,
    retryable: options.retryable === true,
  };
}

function relayToolError(payload) {
  const message = payload?.message || payload?.error || "Browser Relay request failed";
  const err = new Error(payload?.code ? `${payload.code}: ${message}` : message);
  err.payload = payload;
  return err;
}

function toolErrorPayload(err) {
  if (err?.payload) return err.payload;
  const message = err instanceof Error ? err.message : String(err);
  return errorPayload("mcp_tool_error", message);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "browser_tabs",
    description: "List all browser tabs currently attached via the Browser Relay extension. Returns tab IDs, titles, and URLs. Call this first to discover available tabs.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => relayGet("/api/tabs"),
  },
  {
    name: "browser_navigate",
    description: "Navigate a browser tab to a URL. If no tabId is provided, uses the most recently attached tab.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        tabId: { type: "string", description: "Tab targetId (optional, defaults to most recent)" },
      },
      required: ["url"],
    },
    handler: async (args) => relayPost("/api/navigate", args),
  },
  {
    name: "browser_frames",
    description: "List the frame tree for a browser tab. Use this before interacting with iframes; pass the returned frameId to snapshot, click, type, key, scroll, eval, wait, or download.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab targetId (optional)" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      addQueryParam(params, "tabId", args.tabId);
      const qs = params.toString();
      return relayGet(`/api/frames${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_console",
    description: "Read captured console.log/warn/error, page exceptions, and browser log entries from attached tabs. Use this to diagnose page behavior after interactions.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab targetId (optional)" },
        level: { type: "string", description: "Filter by level, e.g. log, warning, error" },
        limit: { type: "number", description: "Maximum entries to return (default: 100)" },
        clear: { type: "boolean", description: "Clear returned entries after reading" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.tabId) params.set("tabId", args.tabId);
      if (args.level) params.set("level", args.level);
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.clear) params.set("clear", "true");
      const qs = params.toString();
      return relayGet(`/api/console${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_network",
    description: "Read captured network request, response, finish, and failure events from attached tabs. Sensitive headers such as Cookie, Authorization, and Set-Cookie are redacted.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab targetId (optional)" },
        type: { type: "string", description: "Filter event type: request, response, finished, failed" },
        method: { type: "string", description: "Filter by HTTP method, e.g. GET or POST" },
        status: { type: "number", description: "Filter responses by HTTP status code" },
        url: { type: "string", description: "Filter entries whose URL contains this text" },
        requestId: { type: "string", description: "Filter by CDP requestId" },
        limit: { type: "number", description: "Maximum entries to return (default: 100)" },
        clear: { type: "boolean", description: "Clear returned entries after reading" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.tabId) params.set("tabId", args.tabId);
      if (args.type) params.set("type", args.type);
      if (args.method) params.set("method", args.method);
      if (args.status !== undefined) params.set("status", String(args.status));
      if (args.url) params.set("url", args.url);
      if (args.requestId) params.set("requestId", args.requestId);
      if (args.limit !== undefined) params.set("limit", String(args.limit));
      if (args.clear) params.set("clear", "true");
      const qs = params.toString();
      return relayGet(`/api/network${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_snapshot",
    description: "Get a text representation of the page. Returns annotated text with clickable elements (links, buttons, inputs) marked for easy reference. Use this to understand what is on the page before interacting.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
        format: { type: "string", enum: ["text", "html"], description: "Output format (default: text)" },
        maxLength: { type: "number", description: "Max output length (default: 100000)" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      addQueryParam(params, "tabId", args.tabId);
      addQueryParam(params, "frameId", args.frameId);
      addQueryParam(params, "format", args.format);
      addQueryParam(params, "maxLength", args.maxLength);
      const qs = params.toString();
      return relayGet(`/api/snapshot${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "browser_click",
    description: "Click an element on the page by CSS selector or locator. Scrolls the element into view first. Returns the text of the clicked element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click (e.g. 'button.submit', 'a[href=\"...\"]')" },
        locator: LOCATOR_SCHEMA,
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
        button: { type: "string", enum: ["left", "middle", "right"], description: "Mouse button (default: left)" },
        doubleClick: { type: "boolean", description: "Double-click instead of single click" },
      },
    },
    handler: async (args) => relayPost("/api/click", args),
  },
  {
    name: "browser_type",
    description: "Type text into an input field. Optionally focus an element by CSS selector or locator first. Can clear the field and/or press Enter to submit.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
        selector: { type: "string", description: "CSS selector to focus before typing (optional)" },
        locator: LOCATOR_SCHEMA,
        submit: { type: "boolean", description: "Press Enter after typing" },
        clear: { type: "boolean", description: "Clear the field before typing" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
      required: ["text"],
    },
    handler: async (args) => relayPost("/api/type", args),
  },
  {
    name: "browser_key",
    description: "Press a key or keyboard shortcut in the active page or a target frame using real Chrome keyboard events. Use for Enter, Escape, Tab, Arrow keys, or shortcuts like Control+L.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Single key to press, e.g. Enter, Escape, ArrowDown, a" },
        combo: { type: "string", description: "Shortcut combo, e.g. Control+L, Shift+Tab, Meta+K" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
        ctrl: { type: "boolean", description: "Hold Control while pressing key" },
        alt: { type: "boolean", description: "Hold Alt/Option while pressing key" },
        shift: { type: "boolean", description: "Hold Shift while pressing key" },
        meta: { type: "boolean", description: "Hold Meta/Command/Windows while pressing key" },
        text: { type: "string", description: "Optional text generated by this key event" },
      },
    },
    handler: async (args) => relayPost("/api/key", args),
  },
  {
    name: "browser_scroll",
    description: "Scroll the page in a direction (up, down, top, bottom).",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "Scroll direction" },
        amount: { type: "number", description: "Pixels to scroll (default: 800)" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
      required: ["direction"],
    },
    handler: async (args) => relayPost("/api/scroll", args),
  },
  {
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the page. Returns base64-encoded image data plus capture strategy and size metadata. Use to visually inspect the current page state.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab targetId (optional)" },
        fullPage: { type: "boolean", description: "Capture the full scrollable page" },
      },
    },
    handler: async (args) => relayPost("/api/screenshot", args || {}),
  },
  {
    name: "browser_eval",
    description: "Evaluate a JavaScript expression in the page context. The escape hatch for any operation not covered by other tools. Returns the evaluation result.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
      required: ["expression"],
    },
    handler: async (args) => relayPost("/api/eval", args),
  },
  {
    name: "browser_wait",
    description: "Wait for a selector, locator, text, URL substring/regex, or JavaScript expression to become true. Supports frameId for iframe waits.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to wait for" },
        locator: LOCATOR_SCHEMA,
        visible: { type: "boolean", description: "Require selector or locator to be visible" },
        text: { type: "string", description: "Text that must appear in document body" },
        url: { type: "string", description: "URL substring that must appear in location.href" },
        urlRegex: { type: "string", description: "Regular expression that must match location.href" },
        expression: { type: "string", description: "JavaScript expression that must evaluate truthy" },
        timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 10000, max: 120000)" },
        pollMs: { type: "number", description: "Polling interval in milliseconds (default: 250)" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
    },
    handler: async (args) => relayPost("/api/wait", args),
  },
  {
    name: "browser_cdp",
    description: "Advanced escape hatch: send a raw Chrome DevTools Protocol command to the attached tab. Use only when high-level tools are insufficient.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "CDP method, e.g. Runtime.evaluate" },
        params: { type: "object", description: "CDP params object" },
        tabId: { type: "string", description: "Tab targetId (optional)" },
        sessionId: { type: "string", description: "Raw debugger session id (optional)" },
      },
      required: ["method"],
    },
    handler: async (args) => relayPost("/api/cdp", args),
  },
  {
    name: "browser_download",
    description: "Get the URL of an image, link, or media element on the page for downloading.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector to find the element (e.g. 'img', 'a.download-link')" },
        locator: LOCATOR_SCHEMA,
        tabId: { type: "string", description: "Tab targetId (optional)" },
        frameId: { type: "string", description: "Frame id from browser_frames (optional)" },
      },
    },
    handler: async (args) => relayPost("/api/download", args),
  },
  {
    name: "browser_download_start",
    description: "Start a real Chrome download from a URL using the browser profile's download manager.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to download" },
        filename: { type: "string", description: "Optional relative filename/path suggested to Chrome" },
        saveAs: { type: "boolean", description: "Ask Chrome to show the save-as dialog" },
        conflictAction: { type: "string", enum: ["uniquify", "overwrite", "prompt"], description: "How Chrome should handle filename conflicts" },
      },
      required: ["url"],
    },
    handler: async (args) => relayPost("/api/download/start", args),
  },
  {
    name: "browser_downloads",
    description: "List Chrome downloads and recent Browser Relay download events. Use clear=true to clear captured relay events.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Filter by Chrome download id" },
        state: { type: "string", enum: ["in_progress", "interrupted", "complete"], description: "Filter by download state" },
        url: { type: "string", description: "Filter by exact URL" },
        filename: { type: "string", description: "Filter by exact filename" },
        query: { type: "string", description: "Search term passed to chrome.downloads.search" },
        limit: { type: "number", description: "Maximum downloads/events to return" },
        clear: { type: "boolean", description: "Clear relay-captured download events" },
      },
    },
    handler: async (args) => {
      if (args.clear) return relayPost("/api/downloads/clear", {});
      const params = new URLSearchParams();
      addQueryParam(params, "id", args.id);
      addQueryParam(params, "state", args.state);
      addQueryParam(params, "url", args.url);
      addQueryParam(params, "filename", args.filename);
      addQueryParam(params, "query", args.query);
      addQueryParam(params, "limit", args.limit);
      const qs = params.toString();
      return relayGet(`/api/downloads${qs ? "?" + qs : ""}`);
    },
  },
];

const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC / MCP protocol over stdio
// ---------------------------------------------------------------------------
let initialized = false;

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendResult(id, result) { send({ jsonrpc: "2.0", id, result }); }
function sendError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    initialized = true;
    return sendResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "browser-relay-mcp", version: PACKAGE_VERSION },
    });
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    return sendResult(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return sendResult(id, { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true });
    }
    try {
      const result = await tool.handler(params?.arguments || {});
      return sendResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return sendResult(id, { content: [{ type: "text", text: JSON.stringify(toolErrorPayload(err), null, 2) }], isError: true });
    }
  }

  if (method === "ping") return sendResult(id, {});

  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Stdio transport: read Content-Length framed JSON-RPC messages
// ---------------------------------------------------------------------------
let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const headerBlock = buffer.slice(0, headerEnd);
    const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;
    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);
    try {
      const msg = JSON.parse(body);
      handleMessage(msg).catch((err) => {
        console.error("MCP handler error:", err);
        if (msg.id !== undefined) sendError(msg.id, -32603, err.message || String(err));
      });
    } catch (err) {
      console.error("MCP parse error:", err);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
