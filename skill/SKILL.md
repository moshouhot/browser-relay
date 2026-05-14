---
name: browser-relay
description: Control the user's local Chrome browser through Browser Relay. For agent browser interaction, use the `browser-relay` CLI by default; use HTTP API mainly when writing code, tests, or integrations. Use for dynamic/login-protected pages, clicking, typing, screenshots, or evaluating JS in tabs that carry the user's real session. Skip static pages and pure REST APIs.
---

# Browser Relay Skill

Control a real Chrome browser via the Browser Relay CLI, HTTP API, or MCP. The browser runs on the user's machine, carrying their login state, cookies, and extensions.

## When to Use

Use Browser Relay when you need to:

- **Scrape dynamic pages** — JavaScript-rendered content, SPAs, dashboards
- **Interact with login-protected sites** — pages that require the user's session (Twitter, Gmail, Notion, etc.)
- **Perform actions** — click buttons, fill forms, scroll, take screenshots
- **Get structured page text** — annotated DOM snapshot with `[link]`, `[button]`, `[input]` markers
- **Evaluate arbitrary JavaScript** in the page context

**When NOT to use:**
- Simple static pages without login — use WebFetch or Jina Reader (faster, cheaper)
- Pure API calls — use the site's REST API directly

## Prerequisites

1. **Relay Server** running (Node.js, default port `18795`)
2. **Browser Relay Chrome Extension** installed and configured with the relay port
3. At least one Chrome tab open and attached (extension auto-attaches all tabs)

## Connection Info

```
Relay URL:  http://127.0.0.1:18795
WebSocket:  ws://127.0.0.1:18795/extension
```

No authentication needed — the relay only accepts connections from localhost.

## Preferred CLI Workflow

When shell access is available, use the `browser-relay` CLI for browser
interaction. Do not hand-write `curl` for normal agent browsing tasks. The CLI
avoids JSON escaping, keeps commands short, and prints compact output by
default.

Use the HTTP API directly only when you are writing code, tests, scripts, or an
integration against Browser Relay, or when the CLI is unavailable. Use `--json`
only when you need the full API response.

```bash
browser-relay tabs
browser-relay frames --tab <tabId>
browser-relay console --tab <tabId> --limit 50
browser-relay network --tab <tabId> --limit 50
browser-relay snapshot --tab <tabId> --max-length 20000
browser-relay snapshot --tab <tabId> --frame <frameId>
browser-relay click 'button[type=submit]' --tab <tabId>
browser-relay click --role button --name 'Save' --exact --tab <tabId>
browser-relay type 'hello world' --selector 'input[name=q]' --clear --submit --tab <tabId> --frame <frameId>
browser-relay type 'hello world' --role textbox --name Search --clear --tab <tabId>
browser-relay key Control+L --tab <tabId>
browser-relay key Enter --tab <tabId> --frame <frameId>
browser-relay wait --selector '#done' --visible --timeout 10000 --tab <tabId>
browser-relay wait --role button --name Save --visible --timeout 10000 --tab <tabId>
browser-relay scroll down --amount 1000 --tab <tabId>
browser-relay download-start https://example.com/file.pdf --filename files/file.pdf
browser-relay downloads --limit 20
browser-relay screenshot /tmp/page.png --full-page --tab <tabId>
browser-relay eval 'document.title' --tab <tabId>
browser-relay cdp Runtime.evaluate --params '{"expression":"document.title","returnByValue":true}' --tab <tabId>
```

`--frame <frameId>` can target same-process iframes and Chrome OOPIF child
targets. Use `browser-relay frames --json` when you need to inspect raw
`oopif: true` frame metadata.

For long text or JavaScript, avoid shell escaping with stdin:

```bash
printf '%s' "$TEXT" | browser-relay type --selector textarea --stdin --tab <tabId>
browser-relay eval --stdin --tab <tabId> < script.js
```

## HTTP API Reference

The HTTP API below is for code, tests, custom tools, and low-level debugging.
For interactive agent work, prefer the CLI workflow above.

### 1. browser_tabs
List all attached browser tabs.
```
GET http://127.0.0.1:18795/api/tabs
```
Returns: `{ ok: true, tabs: [{ id, sessionId, title, url }] }`

### 2. browser_navigate
Navigate a tab to a URL.
```
POST http://127.0.0.1:18795/api/navigate
Header: Content-Type: application/json
Body: { "url": "https://example.com", "tabId?": "optional-target-id" }
```

### 2b. browser_console
Read captured console, page error, and browser log entries.
```
GET http://127.0.0.1:18795/api/console?tabId=<id>&limit=100&level=error&clear=false
POST http://127.0.0.1:18795/api/console/clear
Body: { "tabId?": "...", "level?": "error" }
```
Use this after actions that may trigger frontend errors or warnings.
OOPIF entries keep `tabId` on the root page and include `targetId`, `frameId`,
and `oopif` metadata. `tabId` filters accept a page targetId, child targetId, or
frameId.

### 2c. browser_network
Read captured network request, response, finish, and failure events. Sensitive headers such as Cookie, Authorization, and Set-Cookie are redacted.
```
GET http://127.0.0.1:18795/api/network?tabId=<id>&type=response&method=GET&status=200&limit=100&clear=false
POST http://127.0.0.1:18795/api/network/clear
Body: { "tabId?": "...", "type?": "response", "requestId?": "..." }
```
Use this after navigation or actions that trigger requests to diagnose failed loads, redirects, API statuses, and blocked resources.
OOPIF request entries follow the same root-page `tabId` rule and retain child
target/frame metadata.

### 3. browser_snapshot
Get a text representation of the current page (interactive elements annotated).
```
GET http://127.0.0.1:18795/api/snapshot?tabId=<id>&format=text&maxLength=100000
```
Format can be `"text"` (annotated DOM) or `"html"` (raw HTML).
Pass `frameId=<frameId>` to snapshot an iframe. Get frame ids from `/api/frames`.

### 3b. browser_frames
List a tab's frame tree.
```
GET http://127.0.0.1:18795/api/frames?tabId=<id>
```
Returns: `{ ok: true, frames: [{ id, parentId, name, url, depth }] }`

### 4. browser_click
Click an element by CSS selector or lightweight locator. Scrolls into view first, uses real mouse events.
```
POST http://127.0.0.1:18795/api/click
Body: {
  "selector?": "button.submit",
  "locator?": { "role?": "button", "name?": "Save", "text?": "Save", "exact?": true },
  "tabId?": "...",
  "frameId?": "...",
  "doubleClick?": false
}
```
Pass `"frameId"` to click inside an iframe.

### 5. browser_type
Type text into an input field. Optionally focus an element by CSS selector or locator first, clear, and submit.
```
POST http://127.0.0.1:18795/api/type
Body: {
  "text": "hello world",
  "selector?": "input[name='q']",
  "locator?": { "role?": "textbox", "name?": "Search", "text?": "Query", "exact?": true },
  "clear?": true,
  "submit?": true,
  "tabId?": "..."
}
```
Pass `"frameId"` to type inside an iframe. `clear: true` uses DOM value setters before typing, which is more reliable than only sending Ctrl+A/Backspace.

### 6. browser_scroll
Scroll the page.
```
POST http://127.0.0.1:18795/api/scroll
Body: { "direction": "down|up|top|bottom", "amount?": 800, "tabId?": "..." }
```
Pass `"frameId"` to scroll an iframe.

### 7. browser_key
Press a key or keyboard shortcut using real keyboard events.
```
POST http://127.0.0.1:18795/api/key
Body: { "key?": "Enter", "combo?": "Control+L", "tabId?": "...", "frameId?": "..." }
```

Use `combo` for shortcuts (`Control+L`, `Meta+K`, `Shift+Tab`) and `key`
for single keys (`Enter`, `Escape`, `ArrowDown`, `a`).
Pass `"frameId"` when the focused target is inside an iframe or OOPIF child
target.

### 8. browser_screenshot
Capture a PNG screenshot (base64). Full-page capture uses layout metrics and returns strategy/size metadata.
```
POST/GET http://127.0.0.1:18795/api/screenshot?tabId=<id>&fullPage=true
```
Returns: `{ ok: true, data: "base64...", format: "png", fullPage, strategy, width, height, bytes }`

### 9. browser_eval
Evaluate arbitrary JavaScript in the page. The escape hatch.
```
POST http://127.0.0.1:18795/api/eval
Body: { "expression": "document.querySelector('h1').innerText", "tabId?": "..." }
```
Pass `"frameId"` to evaluate in an iframe.

### 10. browser_download
Get the URL of an image/media/link element.
```
POST http://127.0.0.1:18795/api/download
Body: { "selector?": "img.profile-pic", "locator?": { "role?": "link", "name?": "Download" }, "tabId?": "..." }
```
Pass `"frameId"` to query inside an iframe.

### 11. browser_wait
Wait for page state.
```
POST http://127.0.0.1:18795/api/wait
Body: {
  "selector?": "#done",
  "locator?": { "role?": "button", "name?": "Save", "exact?": true },
  "visible?": true,
  "text?": "Saved",
  "url?": "/dashboard",
  "urlRegex?": "dashboard$",
  "expression?": "window.appReady === true",
  "timeoutMs?": 10000,
  "pollMs?": 250,
  "tabId?": "...",
  "frameId?": "..."
}
```

Lightweight locators are pragmatic approximations for agent use. Prefer CSS when stable; use `role`, `name`, `text`, and `exact` when the page has no durable selector.

### 12. browser_cdp
Advanced local escape hatch for Chrome DevTools Protocol commands.
```
POST http://127.0.0.1:18795/api/cdp
Body: { "method": "Runtime.evaluate", "params?": {}, "tabId?": "...", "sessionId?": "..." }
```
Use this only when high-level commands are insufficient.

## Error Model

Failures return structured JSON while keeping the legacy top-level `error`
string:

```json
{
  "ok": false,
  "code": "element_not_found",
  "error": "Element not found: button.submit",
  "message": "Element not found: button.submit",
  "status": 200,
  "retryable": false,
  "details": { "selector": "button.submit" }
}
```

For automation, branch on `code` instead of parsing `error`. Use
`browser-relay <command> --json` when you need the full envelope. MCP tools
return the same JSON in the tool content and set `isError: true` for
`ok:false` responses.

### 10. browser_download_start
Start a real Chrome download from a URL using the user's browser profile.
```
POST http://127.0.0.1:18795/api/download/start
Body: {
  "url": "https://example.com/file.pdf",
  "filename?": "files/file.pdf",
  "saveAs?": false,
  "conflictAction?": "uniquify|overwrite|prompt"
}
```
Returns: `{ ok: true, downloadId, id, options }`

### 11. browser_downloads
List Chrome downloads plus recent Browser Relay download events.
```
GET http://127.0.0.1:18795/api/downloads?limit=20&state=complete
POST http://127.0.0.1:18795/api/downloads/clear
```
Use this after `browser_download_start` to verify completion or diagnose interruptions.

Real downloads require the extension's `downloads` permission. If Browser Relay
was already loaded in Chrome before this capability was installed, reload the
unpacked extension in `chrome://extensions`.

## Agent Decision Workflow

When asked to do something with a web page:

1. **`browser-relay tabs` first** — discover available tabs and their URLs
2. **`browser-relay frames`** when the target is inside an iframe
3. **`browser-relay navigate`** if needed — go to the target page
4. **`browser-relay snapshot`** — understand the page structure
5. **Plan actions** based on snapshot (click what, type where)
6. **Execute** (`browser-relay click`, `browser-relay type`, `browser-relay key`, `browser-relay scroll`) one at a time
7. **`browser-relay wait`** after actions that trigger async UI changes
8. **`browser-relay console`** if the page behaves unexpectedly or after risky actions
9. **`browser-relay network`** after navigation or if requests fail, hang, or return unexpected statuses
10. **Use `browser-relay download-start` and `browser-relay downloads`** for real file downloads
11. **Re-snapshot** after each action to verify state
12. **Screenshot** if visual confirmation is needed

## Example Session

```bash
# 1. List tabs
browser-relay tabs
# ABC123    Google    https://google.com

# 2. Take snapshot to see the page
browser-relay snapshot --tab ABC123
# [input type=text name=q placeholder="Search Google"]
# [button "Google Search"]

# 3. Type into the search box
browser-relay type 'browser relay' --selector 'input[name=q]' --submit --tab ABC123

# 4. New snapshot after navigation
browser-relay snapshot --tab ABC123

# 5. Click a result
browser-relay click 'a[href*="github.com"]' --tab ABC123
```

## MCP Registration (Claude Desktop / Cursor / Windsurf)

Add to your MCP config (`~/.claude/mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "browser": {
      "command": "browser-relay-mcp",
      "env": {
        "BROWSER_RELAY_URL": "http://127.0.0.1:18795"
      }
    }
  }
}
```

## Error Patterns

| Error | Meaning | Fix |
|-------|---------|-----|
| Extension not connected | Relay server is running but no browser extension connected | Check that Chrome is running with the Browser Relay extension installed |
| No attached tabs | Extension connected but no tab is attached | The extension auto-attaches all regular tabs. Make sure at least one non-chrome:// tab is open |
| Element not found: selector | The CSS selector did not match anything on the page | Try a different selector, or take a snapshot first to inspect the DOM |

## Health Check

```bash
curl http://127.0.0.1:18795/
# → OK

curl http://127.0.0.1:18795/api/debug
# → { "version": "<package-version>", "connected": true/false, "tabCount": N }
```
