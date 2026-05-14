#!/usr/bin/env node
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { SNAPSHOT_JS } from "./snapshot.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const RELAY_HOST = process.env.BROWSER_RELAY_HOST || "127.0.0.1";
const RELAY_PORT = parseInt(process.env.BROWSER_RELAY_PORT || "18795", 10);
const RELAY_VERSION = JSON.parse(readFileSync(join(__pkgDir, "package.json"), "utf-8")).version;
const PING_INTERVAL_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EXTENSION_GRACE_MS = 20_000;
const MAX_BODY_SIZE = 64 * 1024; // 64KB
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_WAIT_POLL_MS = 250;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const MAX_CONSOLE_ENTRIES = 1_000;
const MAX_NETWORK_ENTRIES = 1_000;
const MAX_DOWNLOAD_ENTRIES = 1_000;
const SENSITIVE_NETWORK_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

const serverStartTime = Date.now();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(event, level, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, event, level, ...data }));
}

const LOG = {
  info: (event, data) => log(event, "info", data),
  warn: (event, data) => log(event, "warn", data),
  error: (event, data) => log(event, "error", data),
};

// ---------------------------------------------------------------------------
// Extension WebSocket state
// ---------------------------------------------------------------------------
let extensionWs = null;
let extensionConnectedSince = null;
let extensionRemoteAddress = null;

const connectedTargets = new Map(); // sessionId -> { sessionId, targetId, targetInfo, parentSessionId?, rootSessionId?, frameId? }
let nextExtensionId = 1;
const pendingCommands = new Map();
let nextConsoleEntryId = 1;
let consoleEntries = [];
const consoleEnabledSessions = new Set();
let nextNetworkEntryId = 1;
let networkEntries = [];
const networkEnabledSessions = new Set();
const networkRequestMeta = new Map();
let nextDownloadEntryId = 1;
let downloadEntries = [];

let pingTimer = null;
let graceTimer = null;
const reconnectWaiters = new Set();

function extensionConnected() {
  return extensionWs?.readyState === WebSocket.OPEN;
}

function flushReconnectWaiters(connected) {
  for (const waiter of reconnectWaiters) waiter(connected);
  reconnectWaiters.clear();
}

function clearGraceTimer() {
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
}

function scheduleGraceCleanup() {
  clearGraceTimer();
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (!extensionConnected()) { connectedTargets.clear(); consoleEnabledSessions.clear(); networkEnabledSessions.clear(); flushReconnectWaiters(false); }
  }, EXTENSION_GRACE_MS);
}

function waitForExtension(timeoutMs = 3_000) {
  if (extensionConnected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const waiter = (connected) => { if (settled) return; settled = true; clearTimeout(timer); reconnectWaiters.delete(waiter); resolve(connected); };
    const timer = setTimeout(() => waiter(false), timeoutMs);
    reconnectWaiters.add(waiter);
  });
}

// ---------------------------------------------------------------------------
// Send CDP command to extension
// ---------------------------------------------------------------------------
function sendToExtension(method, params, sessionId) {
  const ws = extensionWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(relayError("extension_not_connected", "Extension not connected", { status: 503, retryable: true }));
  }
  const id = nextExtensionId++;
  const payload = { id, method: "forwardCDPCommand", params: { method, params, ...(sessionId ? { sessionId } : {}) } };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(relayError("cdp_timeout", `CDP command timeout: ${method}`, { status: 504, retryable: true, details: { method } }));
    }, COMMAND_TIMEOUT_MS);
    pendingCommands.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      timer,
    });
    try { ws.send(JSON.stringify(payload)); }
    catch (err) { clearTimeout(timer); pendingCommands.delete(id); reject(err instanceof Error ? err : new Error(String(err))); }
  });
}

// ---------------------------------------------------------------------------
// Resolve target
// ---------------------------------------------------------------------------
function targetType(targetInfo = {}) {
  return targetInfo.type || "page";
}

function isPageTarget(targetInfo = {}) {
  return targetType(targetInfo) === "page";
}

function isIframeTarget(targetInfo = {}) {
  return targetType(targetInfo) === "iframe";
}

function frameIdFromTargetInfo(targetInfo = {}) {
  if (typeof targetInfo.frameId === "string" && targetInfo.frameId) return targetInfo.frameId;
  if (isIframeTarget(targetInfo) && typeof targetInfo.targetId === "string" && targetInfo.targetId) return targetInfo.targetId;
  return undefined;
}

function findTargetByTargetId(targetId) {
  if (!targetId) return null;
  for (const target of connectedTargets.values()) {
    if (target.targetId === targetId) return target;
  }
  return null;
}

function rootSessionForSession(sessionId) {
  const target = connectedTargets.get(sessionId);
  if (!target) return sessionId;
  if (target.rootSessionId) return target.rootSessionId;
  let current = target;
  const seen = new Set();
  while (current?.parentSessionId && !seen.has(current.sessionId)) {
    seen.add(current.sessionId);
    current = connectedTargets.get(current.parentSessionId);
  }
  return current?.sessionId || sessionId;
}

function registerAttachedTarget(sessionId, targetInfo = {}, sourceSessionId) {
  if (!sessionId || !targetInfo?.targetId) return;
  const type = targetType(targetInfo);
  if (type !== "page" && type !== "iframe") return;

  const parentSessionId = sourceSessionId && sourceSessionId !== sessionId
    ? sourceSessionId
    : undefined;
  const parentTarget = findTargetByTargetId(targetInfo.parentId);
  const rootSessionId = isPageTarget(targetInfo)
    ? sessionId
    : rootSessionForSession(parentSessionId || parentTarget?.sessionId || sessionId);

  connectedTargets.set(sessionId, {
    sessionId,
    targetId: targetInfo.targetId,
    targetInfo,
    parentSessionId: parentSessionId || parentTarget?.sessionId,
    parentTargetId: targetInfo.parentId || parentTarget?.targetId,
    rootSessionId,
    frameId: frameIdFromTargetInfo(targetInfo),
  });
}

function deleteConnectedTarget(sessionId) {
  const target = connectedTargets.get(sessionId);
  const sessionsToDelete = new Set([sessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [childSessionId, childTarget] of connectedTargets) {
      if (sessionsToDelete.has(childSessionId)) continue;
      if (
        sessionsToDelete.has(childTarget.parentSessionId) ||
        (target && isPageTarget(target.targetInfo) && childTarget.rootSessionId === sessionId)
      ) {
        sessionsToDelete.add(childSessionId);
        changed = true;
      }
    }
  }
  for (const sid of sessionsToDelete) {
    connectedTargets.delete(sid);
    consoleEnabledSessions.delete(sid);
    networkEnabledSessions.delete(sid);
  }
}

function deleteConnectedTargetByTargetId(targetId) {
  for (const [sessionId, target] of connectedTargets) {
    if (target.targetId === targetId) deleteConnectedTarget(sessionId);
  }
}

function pageTargets() {
  return Array.from(connectedTargets.values()).filter((target) => isPageTarget(target.targetInfo));
}

function resolveSession(targetId) {
  if (targetId) {
    const target = findTargetByTargetId(targetId);
    if (target) return target.sessionId;
    throw relayError("tab_not_found", `No attached tab with targetId: ${targetId}`, { status: 404, details: { targetId } });
  }
  let last = null;
  for (const target of pageTargets()) last = target;
  if (!last) throw relayError("no_attached_tabs", "No attached tabs. Install the Browser Relay extension and open a tab.", { status: 409, retryable: true });
  return last.sessionId;
}

function resolveTab(tabId) {
  return resolveSession(tabId);
}

function targetForSession(sessionId) {
  return connectedTargets.get(sessionId) || null;
}

function eventContextForSession(sessionId) {
  const target = targetForSession(sessionId);
  const root = connectedTargets.get(rootSessionForSession(sessionId)) || target;
  const pageTarget = root && isPageTarget(root.targetInfo) ? root : target;
  return {
    target,
    pageTarget,
    tabId: pageTarget?.targetId || target?.targetId || "",
    targetId: target?.targetId || "",
    frameId: target?.frameId || "",
    oopif: Boolean(target && isIframeTarget(target.targetInfo)),
  };
}

function sessionsForTargetScope(targetId) {
  if (!targetId) return [...connectedTargets.keys()];
  let scopedTarget = null;
  for (const target of connectedTargets.values()) {
    if (target.targetId === targetId || target.frameId === targetId) {
      scopedTarget = target;
      break;
    }
  }
  const sessionId = scopedTarget?.sessionId || resolveTab(targetId);
  const rootSessionId = rootSessionForSession(sessionId);
  return [...connectedTargets.values()]
    .filter((target) => target.sessionId === rootSessionId || target.rootSessionId === rootSessionId)
    .map((target) => target.sessionId);
}

function entryMatchesTarget(entry, targetId) {
  if (!targetId) return true;
  return entry.tabId === targetId || entry.targetId === targetId || entry.frameId === targetId;
}

function remoteObjectValue(obj) {
  if (!obj || typeof obj !== "object") return "";
  if ("value" in obj) return obj.value;
  if ("unserializableValue" in obj) return obj.unserializableValue;
  return obj.description || obj.type || "";
}

function stringifyConsoleValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try { return JSON.stringify(value); }
  catch { return String(value); }
}

function appendConsoleEntry(entry) {
  consoleEntries.push({ id: nextConsoleEntryId++, receivedAt: new Date().toISOString(), ...entry });
  if (consoleEntries.length > MAX_CONSOLE_ENTRIES) {
    consoleEntries = consoleEntries.slice(-MAX_CONSOLE_ENTRIES);
  }
}

function appendConsoleEvent(sessionId, method, params = {}) {
  const context = eventContextForSession(sessionId);
  const target = context.target;
  const base = {
    sessionId: sessionId || "",
    tabId: context.tabId,
    targetId: context.targetId,
    frameId: context.frameId,
    oopif: context.oopif,
    url: target?.targetInfo?.url || "",
    title: target?.targetInfo?.title || "",
  };

  if (method === "Runtime.consoleAPICalled") {
    const args = (params.args || []).map(remoteObjectValue);
    appendConsoleEntry({
      ...base,
      source: "runtime",
      level: params.type || "log",
      text: args.map(stringifyConsoleValue).join(" "),
      args,
      stackTrace: params.stackTrace || null,
      timestamp: params.timestamp || null,
    });
    return;
  }

  if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails || {};
    appendConsoleEntry({
      ...base,
      source: "runtime",
      level: "error",
      text: details.exception?.description || details.text || "Uncaught exception",
      exceptionDetails: details,
      timestamp: params.timestamp || null,
    });
    return;
  }

  if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    appendConsoleEntry({
      ...base,
      source: entry.source || "log",
      level: entry.level || "info",
      text: entry.text || "",
      lineNumber: entry.lineNumber,
      url: entry.url || base.url,
      networkRequestId: entry.networkRequestId,
      timestamp: entry.timestamp || null,
    });
  }
}

async function enableConsoleCapture(sessionId) {
  if (!sessionId || consoleEnabledSessions.has(sessionId)) return;
  consoleEnabledSessions.add(sessionId);
  try { await sendToExtension("Runtime.enable", {}, sessionId); }
  catch (err) {
    consoleEnabledSessions.delete(sessionId);
    throw err;
  }
  await sendToExtension("Log.enable", {}, sessionId).catch(() => {});
}

function sanitizeNetworkHeaders(headers = {}) {
  const sanitized = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = String(name).toLowerCase();
    if (SENSITIVE_NETWORK_HEADERS.has(key)) {
      sanitized[name] = "[redacted]";
      continue;
    }
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    sanitized[name] = text.length > 1_000 ? `${text.slice(0, 1_000)}...` : text;
  }
  return sanitized;
}

function pruneNetworkRequestMeta() {
  if (networkRequestMeta.size <= MAX_NETWORK_ENTRIES * 2) return;
  for (const key of networkRequestMeta.keys()) {
    networkRequestMeta.delete(key);
    if (networkRequestMeta.size <= MAX_NETWORK_ENTRIES) break;
  }
}

function appendNetworkEntry(entry) {
  networkEntries.push({ id: nextNetworkEntryId++, receivedAt: new Date().toISOString(), ...entry });
  if (networkEntries.length > MAX_NETWORK_ENTRIES) {
    networkEntries = networkEntries.slice(-MAX_NETWORK_ENTRIES);
  }
}

function baseNetworkEntry(sessionId) {
  const context = eventContextForSession(sessionId);
  const target = context.target;
  const pageTarget = context.pageTarget;
  return {
    sessionId: sessionId || "",
    tabId: context.tabId,
    targetId: context.targetId,
    frameId: context.frameId,
    oopif: context.oopif,
    pageUrl: pageTarget?.targetInfo?.url || target?.targetInfo?.url || "",
    title: pageTarget?.targetInfo?.title || target?.targetInfo?.title || "",
  };
}

function appendNetworkEvent(sessionId, method, params = {}) {
  const base = baseNetworkEntry(sessionId);
  const requestId = params.requestId || "";
  const meta = requestId ? networkRequestMeta.get(requestId) : null;

  if (method === "Network.requestWillBeSent") {
    const request = params.request || {};
    const entry = {
      ...base,
      type: "request",
      pageUrl: params.documentURL || base.pageUrl,
      requestId,
      loaderId: params.loaderId || "",
      documentURL: params.documentURL || "",
      url: request.url || params.documentURL || base.pageUrl,
      method: request.method || "",
      resourceType: params.type || "",
      headers: sanitizeNetworkHeaders(request.headers),
      hasPostData: Boolean(request.hasPostData || request.postData),
      initiator: params.initiator || null,
      timestamp: params.timestamp || null,
      wallTime: params.wallTime || null,
    };
    if (requestId) {
      networkRequestMeta.set(requestId, {
        method: entry.method,
        url: entry.url,
        documentURL: entry.documentURL,
        resourceType: entry.resourceType,
        tabId: entry.tabId,
      });
      pruneNetworkRequestMeta();
    }
    appendNetworkEntry(entry);
    return;
  }

  if (method === "Network.responseReceived") {
    const response = params.response || {};
    appendNetworkEntry({
      ...base,
      type: "response",
      pageUrl: meta?.documentURL || base.pageUrl,
      requestId,
      loaderId: params.loaderId || "",
      url: response.url || meta?.url || base.pageUrl,
      method: meta?.method || "",
      status: response.status,
      statusText: response.statusText || "",
      resourceType: params.type || meta?.resourceType || "",
      mimeType: response.mimeType || "",
      protocol: response.protocol || "",
      remoteIPAddress: response.remoteIPAddress || "",
      remotePort: response.remotePort,
      fromDiskCache: Boolean(response.fromDiskCache),
      fromServiceWorker: Boolean(response.fromServiceWorker),
      encodedDataLength: response.encodedDataLength,
      headers: sanitizeNetworkHeaders(response.headers),
      timestamp: params.timestamp || null,
    });
    return;
  }

  if (method === "Network.loadingFinished") {
    appendNetworkEntry({
      ...base,
      type: "finished",
      pageUrl: meta?.documentURL || base.pageUrl,
      requestId,
      url: meta?.url || base.pageUrl,
      method: meta?.method || "",
      resourceType: meta?.resourceType || "",
      encodedDataLength: params.encodedDataLength,
      timestamp: params.timestamp || null,
    });
    if (requestId) networkRequestMeta.delete(requestId);
    return;
  }

  if (method === "Network.loadingFailed") {
    appendNetworkEntry({
      ...base,
      type: "failed",
      pageUrl: meta?.documentURL || base.pageUrl,
      requestId,
      url: meta?.url || base.pageUrl,
      method: meta?.method || "",
      resourceType: params.type || meta?.resourceType || "",
      errorText: params.errorText || "",
      blockedReason: params.blockedReason || "",
      canceled: Boolean(params.canceled),
      corsErrorStatus: params.corsErrorStatus || null,
      timestamp: params.timestamp || null,
    });
    if (requestId) networkRequestMeta.delete(requestId);
  }
}

async function enableNetworkCapture(sessionId) {
  if (!sessionId || networkEnabledSessions.has(sessionId)) return;
  networkEnabledSessions.add(sessionId);
  try {
    await sendToExtension("Network.enable", {}, sessionId);
  } catch (err) {
    networkEnabledSessions.delete(sessionId);
    throw err;
  }
}

function positiveNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function findFrameTarget(sessionId, frameId) {
  if (!frameId) return null;
  const rootSessionId = rootSessionForSession(sessionId);
  for (const target of connectedTargets.values()) {
    if (!isIframeTarget(target.targetInfo)) continue;
    if (target.rootSessionId !== rootSessionId) continue;
    if (target.frameId === frameId || target.targetId === frameId) return target;
  }
  return null;
}

function resolveFrameCommandSession(sessionId, frameId) {
  const target = findFrameTarget(sessionId, frameId);
  if (!target) return { sessionId, frameId, oopif: false };
  return { sessionId: target.sessionId, frameId: undefined, oopif: true, target };
}

// ---------------------------------------------------------------------------
// Handle extension messages
// ---------------------------------------------------------------------------
function appendDownloadEvent(type, params = {}) {
  const entry = {
    eventId: nextDownloadEntryId++,
    receivedAt: new Date().toISOString(),
    type,
    ...params,
  };
  if (params.id !== undefined && entry.downloadId === undefined) {
    entry.downloadId = params.id;
  }
  downloadEntries.push(entry);
  if (downloadEntries.length > MAX_DOWNLOAD_ENTRIES) {
    downloadEntries = downloadEntries.slice(-MAX_DOWNLOAD_ENTRIES);
  }
}

function onExtensionMessage(data) {
  let msg;
  try { msg = JSON.parse(typeof data === "string" ? data : data.toString()); } catch { return; }

  if (msg?.method === "pong") return;

  if (typeof msg?.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = pendingCommands.get(msg.id);
    if (!pending) return;
    pendingCommands.delete(msg.id);
    if (msg.error) pending.reject(new Error(String(msg.error)));
    else pending.resolve(msg.result);
    return;
  }

  if (msg?.method === "forwardCDPEvent") {
    const sourceSessionId = msg.params?.sessionId;
    const cdpMethod = msg.params?.method;
    const cdpParams = msg.params?.params;
    const eventSessionId = msg.params?.sessionId;

    if (eventSessionId && (
      cdpMethod === "Runtime.consoleAPICalled" ||
      cdpMethod === "Runtime.exceptionThrown" ||
      cdpMethod === "Log.entryAdded"
    )) {
      appendConsoleEvent(eventSessionId, cdpMethod, cdpParams);
    }

    if (eventSessionId && (
      cdpMethod === "Network.requestWillBeSent" ||
      cdpMethod === "Network.responseReceived" ||
      cdpMethod === "Network.loadingFinished" ||
      cdpMethod === "Network.loadingFailed"
    )) {
      appendNetworkEvent(eventSessionId, cdpMethod, cdpParams);
    }

    if (cdpMethod === "BrowserRelay.downloadCreated") {
      appendDownloadEvent("created", cdpParams);
      return;
    }
    if (cdpMethod === "BrowserRelay.downloadChanged") {
      appendDownloadEvent("changed", cdpParams);
      return;
    }
    if (cdpMethod === "BrowserRelay.downloadErased") {
      appendDownloadEvent("erased", cdpParams);
      return;
    }

    if (cdpMethod === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = cdpParams || {};
      registerAttachedTarget(sessionId, targetInfo, sourceSessionId);
      const type = targetInfo?.type ?? "page";
      if (sessionId && targetInfo?.targetId && (type === "page" || type === "iframe")) {
        void enableConsoleCapture(sessionId).catch((err) => LOG.warn("console.enable.failed", { sessionId, error: err.message || String(err) }));
        void enableNetworkCapture(sessionId).catch((err) => LOG.warn("network.enable.failed", { sessionId, error: err.message || String(err) }));
      }
    } else if (cdpMethod === "Target.detachedFromTarget") {
      const { sessionId, targetId } = cdpParams || {};
      if (sessionId) deleteConnectedTarget(sessionId);
      else if (targetId) deleteConnectedTargetByTargetId(targetId);
    } else if (cdpMethod === "Target.targetInfoChanged") {
      const info = cdpParams?.targetInfo;
      if (info?.targetId) {
        for (const [sid, t] of connectedTargets) {
          if (t.targetId === info.targetId) {
            const targetInfo = { ...t.targetInfo, ...info };
            connectedTargets.set(sid, { ...t, targetInfo, frameId: frameIdFromTargetInfo(targetInfo) || t.frameId });
          }
        }
      }
    } else if (cdpMethod === "Target.targetDestroyed" || cdpMethod === "Target.targetCrashed") {
      const targetId = cdpParams?.targetId;
      if (targetId) deleteConnectedTargetByTargetId(targetId);
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function relayError(code, message, options = {}) {
  const err = new Error(message);
  err.relayCode = code;
  err.status = options.status;
  err.details = options.details;
  err.retryable = options.retryable;
  return err;
}

function defaultCodeForStatus(status) {
  if (status === 400) return "invalid_request";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 413) return "request_too_large";
  if (status === 503) return "extension_not_connected";
  if (status === 504) return "cdp_timeout";
  return status >= 500 ? "internal_error" : "request_failed";
}

function errorPayload(code, message, options = {}) {
  const payload = {
    ok: false,
    code,
    error: message,
    message,
    status: options.status ?? 500,
    retryable: options.retryable === true,
  };
  if (options.details !== undefined) payload.details = options.details;
  return payload;
}

function normalizeError(err, fallbackStatus = 500) {
  if (err && typeof err === "object" && err.relayCode) {
    return errorPayload(err.relayCode, err.message || String(err), {
      status: err.status || fallbackStatus,
      retryable: err.retryable,
      details: err.details,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  if (message === "Extension disconnected") {
    return errorPayload("extension_disconnected", message, { status: 503, retryable: true });
  }
  if (message.startsWith("No attached tab with targetId: ")) {
    const targetId = message.slice("No attached tab with targetId: ".length);
    return errorPayload("tab_not_found", message, { status: 404, details: { targetId } });
  }
  if (message.startsWith("CDP command timeout: ")) {
    const method = message.slice("CDP command timeout: ".length);
    return errorPayload("cdp_timeout", message, { status: 504, retryable: true, details: { method } });
  }
  if (message.startsWith("Request body too large")) {
    return errorPayload("request_too_large", message, { status: 413 });
  }
  if (message === "Invalid JSON in request body") {
    return errorPayload("invalid_json", message, { status: 400 });
  }
  return errorPayload(defaultCodeForStatus(fallbackStatus), message, { status: fallbackStatus });
}

function errorResponse(res, status, message, options = {}) {
  const code = options.code || defaultCodeForStatus(status);
  jsonResponse(res, status, errorPayload(code, message, { ...options, status }));
}

function validationError(res, message, field) {
  return errorResponse(res, 400, message, {
    code: "invalid_request",
    details: field ? { field } : undefined,
  });
}

async function readBody(req) {
  const chunks = []; let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) throw relayError("request_too_large", "Request body too large (max 64KB)", { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw relayError("invalid_json", "Invalid JSON in request body", { status: 400 }); }
}

function boundedNumber(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function ensureExtension() {
  if (extensionConnected()) return;
  const reconnected = await waitForExtension(3_000);
  if (!reconnected || !extensionConnected()) {
    throw relayError("extension_not_connected", "Extension not connected. Is the browser running with the extension?", { status: 503, retryable: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenFrameTree(node, depth = 0, parentId = null, out = []) {
  if (!node?.frame) return out;
  const frame = node.frame;
  out.push({
    id: frame.id,
    parentId,
    name: frame.name || "",
    url: frame.url || "",
    securityOrigin: frame.securityOrigin || "",
    mimeType: frame.mimeType || "",
    depth,
  });
  for (const child of node.childFrames || []) {
    flattenFrameTree(child, depth + 1, frame.id, out);
  }
  return out;
}

async function getFrameTree(sessionId) {
  const result = await sendToExtension("Page.getFrameTree", {}, sessionId);
  return result?.frameTree || null;
}

async function getFrameContextId(sessionId, frameId) {
  if (!frameId) return undefined;
  const result = await sendToExtension("Page.createIsolatedWorld", {
    frameId,
    worldName: "browser-relay",
    // CDP exposes this option with the historical "Univeral" typo.
    grantUniveralAccess: true,
  }, sessionId);
  return result?.executionContextId;
}

async function evaluateInFrame(sessionId, expression, options = {}) {
  const { frameId, returnByValue = true, awaitPromise = true } = options;
  const target = resolveFrameCommandSession(sessionId, frameId);
  const params = { expression, returnByValue, awaitPromise };
  const contextId = await getFrameContextId(target.sessionId, target.frameId);
  if (contextId) params.contextId = contextId;
  return await sendToExtension("Runtime.evaluate", params, target.sessionId);
}

async function frameViewportOffset(sessionId, frameId) {
  if (!frameId) return { x: 0, y: 0 };
  if (findFrameTarget(sessionId, frameId)) return { x: 0, y: 0 };
  try {
    const owner = await sendToExtension("DOM.getFrameOwner", { frameId }, sessionId);
    const backendNodeId = owner?.backendNodeId;
    if (!backendNodeId) return { x: 0, y: 0 };
    const model = await sendToExtension("DOM.getBoxModel", { backendNodeId }, sessionId);
    const content = model?.model?.content;
    if (!Array.isArray(content) || content.length < 8) return { x: 0, y: 0 };
    const xs = [content[0], content[2], content[4], content[6]];
    const ys = [content[1], content[3], content[5], content[7]];
    return { x: Math.min(...xs), y: Math.min(...ys) };
  } catch {
    return { x: 0, y: 0 };
  }
}

function parseJsonString(value, fallback = {}) {
  try { return JSON.parse(value || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(String(address || ""));
}

function runtimeExceptionMessage(result) {
  const details = result?.exceptionDetails;
  if (!details) return null;
  return details.exception?.description || details.text || "JavaScript evaluation failed";
}

function normalizeLocator(input) {
  if (!input) return null;
  const raw = typeof input === "string" ? { selector: input } : input;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const locator = {};
  for (const key of ["selector", "text", "role", "name"]) {
    if (typeof raw[key] === "string" && raw[key].trim()) locator[key] = raw[key].trim();
  }
  if (raw.exact === true) locator.exact = true;
  return Object.keys(locator).length ? locator : null;
}

function locatorFromBody(body, options = {}) {
  const { allowText = false, allowLocatorText = true } = options;
  const locator = normalizeLocator(body.locator);
  if (locator) return locator;
  const direct = {
    selector: body.selector,
    text: allowText ? body.text : undefined,
    role: body.role,
    name: body.name,
    exact: body.exact,
  };
  if (allowLocatorText && typeof body.locatorText === "string") direct.text = body.locatorText;
  return normalizeLocator(direct);
}

function locatorDescription(locator) {
  if (!locator) return "element";
  const parts = [];
  for (const key of ["selector", "role", "name", "text"]) {
    if (locator[key]) parts.push(`${key}=${JSON.stringify(locator[key])}`);
  }
  if (locator.exact) parts.push("exact=true");
  return parts.length ? parts.join(" ") : "element";
}

function elementNotFound(locator, frameId) {
  const description = typeof locator === "string" ? locator : locatorDescription(locator);
  const details = { locator };
  if (frameId !== undefined) details.frameId = frameId;
  const payload = errorPayload("element_not_found", `Element not found: ${description}`, {
    status: 200,
    details,
  });
  payload.locator = locator;
  if (frameId !== undefined) payload.frameId = frameId;
  return payload;
}

function elementResolverExpression(locator, foundExpression) {
  return `(function() {
    var locator = ${JSON.stringify(locator)};
    function normalize(value) {
      return String(value || '').replace(/\\s+/g, ' ').trim();
    }
    function includesOrEquals(value, expected, exact) {
      value = normalize(value).toLowerCase();
      expected = normalize(expected).toLowerCase();
      if (!expected) return true;
      return exact ? value === expected : value.includes(expected);
    }
    function implicitRole(el) {
      var tag = el.tagName ? el.tagName.toLowerCase() : '';
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'option') return 'option';
      if (tag === 'input') {
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'textbox';
      }
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return '';
    }
    function elementRole(el) {
      return normalize(el.getAttribute('role') || implicitRole(el)).toLowerCase();
    }
    function elementName(el) {
      return normalize(
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('alt') ||
        el.getAttribute('placeholder') ||
        el.value ||
        el.innerText ||
        el.textContent
      );
    }
    function elementText(el) {
      return normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label'));
    }
    function matches(el) {
      if (!el) return false;
      if (locator.role && elementRole(el) !== normalize(locator.role).toLowerCase()) return false;
      if (locator.name && !includesOrEquals(elementName(el), locator.name, locator.exact)) return false;
      if (locator.text && !includesOrEquals(elementText(el), locator.text, locator.exact)) return false;
      return true;
    }
    var candidates = [];
    if (locator.selector) {
      try { candidates = Array.from(document.querySelectorAll(locator.selector)); }
      catch (err) { return JSON.stringify({ found: false, selectorError: err.message || String(err), locator: locator }); }
    } else {
      candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,option,[role],[aria-label],[contenteditable],label,h1,h2,h3,h4,h5,h6'));
    }
    var el = candidates.find(matches) || null;
    ${foundExpression}
  })()`;
}

function hasWaitCondition(body) {
  return !!locatorFromBody(body) || ["text", "url", "urlRegex", "expression"]
    .some((key) => typeof body[key] === "string" && body[key]);
}

async function findElement(sessionId, locator, frameId) {
  const findJs = elementResolverExpression(locator, `
    if (!el) return JSON.stringify({ found: false, locator: locator });
    var rect = el.getBoundingClientRect();
    return JSON.stringify({
      found: true,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      tag: el.tagName,
      role: el.getAttribute('role') || '',
      text: (el.innerText || el.textContent || el.value || '').trim().slice(0, 100)
    });
  `);
  const result = await evaluateInFrame(sessionId, findJs, { frameId });
  const info = parseJsonString(result?.result?.value, { found: false });
  if (!info.found) return info;
  const offset = await frameViewportOffset(sessionId, frameId);
  return { ...info, x: info.x + offset.x, y: info.y + offset.y };
}

async function scrollFrameIntoView(sessionId, frameId) {
  if (!frameId) return;
  try {
    const owner = await sendToExtension("DOM.getFrameOwner", { frameId }, sessionId);
    const backendNodeId = owner?.backendNodeId;
    if (backendNodeId) {
      await sendToExtension("DOM.scrollIntoViewIfNeeded", { backendNodeId }, sessionId);
    }
  } catch {
    // Best effort only; frame-local scrolling still runs below.
  }
}

async function scrollElementIntoView(sessionId, locator, frameId) {
  await scrollFrameIntoView(sessionId, frameId);
  const js = elementResolverExpression(locator, `
    if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
    return JSON.stringify({ found: !!el });
  `);
  await evaluateInFrame(sessionId, js, { frameId }).catch(() => {});
}

const NAMED_KEYS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  del: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

function modifierMaskFrom(body, comboParts = []) {
  let modifiers = Number.isInteger(body.modifiers) ? body.modifiers : 0;
  const names = new Set(comboParts.map((part) => part.toLowerCase()));
  if (body.alt === true || names.has("alt") || names.has("option")) modifiers |= 1;
  if (body.ctrl === true || body.control === true || names.has("ctrl") || names.has("control")) modifiers |= 2;
  if (body.meta === true || body.cmd === true || body.command === true || names.has("meta") || names.has("cmd") || names.has("command")) modifiers |= 4;
  if (body.shift === true || names.has("shift")) modifiers |= 8;
  return modifiers;
}

function keyDefinition(rawKey, modifiers, explicitText) {
  const raw = String(rawKey || "").trim();
  if (!raw) return null;
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) return { ...named, text: explicitText ?? named.text ?? "" };

  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    const hasCommandModifier = (modifiers & 1) || (modifiers & 2) || (modifiers & 4);
    if (/^[A-Z]$/i.test(raw)) {
      const key = hasCommandModifier && !(modifiers & 8) ? raw.toLowerCase() : raw;
      return {
        key,
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        text: explicitText ?? (hasCommandModifier ? "" : raw),
      };
    }
    if (/^\d$/.test(raw)) {
      return {
        key: raw,
        code: `Digit${raw}`,
        windowsVirtualKeyCode: raw.charCodeAt(0),
        text: explicitText ?? (hasCommandModifier ? "" : raw),
      };
    }
    return {
      key: raw,
      code: raw === " " ? "Space" : "",
      windowsVirtualKeyCode: raw.charCodeAt(0),
      text: explicitText ?? (hasCommandModifier ? "" : raw),
    };
  }

  return { key: raw, code: raw, windowsVirtualKeyCode: 0, text: explicitText ?? "" };
}

function normalizeKeyInput(body) {
  let rawCombo = "";
  if (typeof body.combo === "string" && body.combo.trim()) rawCombo = body.combo;
  else if (typeof body.key === "string" && body.key.trim()) rawCombo = body.key;
  if (!rawCombo) return null;
  const parts = rawCombo.split("+").map((part) => part.trim()).filter(Boolean);
  const keyPart = parts.length ? parts[parts.length - 1] : rawCombo;
  const modifiers = modifierMaskFrom(body, parts.slice(0, -1));
  const explicitText = typeof body.text === "string" ? body.text : undefined;
  const definition = keyDefinition(keyPart, modifiers, explicitText);
  if (!definition) return null;
  return {
    key: definition.key,
    code: body.code || definition.code || definition.key,
    windowsVirtualKeyCode: body.windowsVirtualKeyCode || definition.windowsVirtualKeyCode || 0,
    nativeVirtualKeyCode: body.nativeVirtualKeyCode || body.windowsVirtualKeyCode || definition.windowsVirtualKeyCode || 0,
    text: definition.text || "",
    modifiers,
  };
}

async function dispatchKeyPress(sessionId, input) {
  const base = {
    key: input.key,
    code: input.code,
    windowsVirtualKeyCode: input.windowsVirtualKeyCode,
    nativeVirtualKeyCode: input.nativeVirtualKeyCode,
    modifiers: input.modifiers,
  };
  const down = input.text ? { ...base, text: input.text, unmodifiedText: input.text } : base;
  await sendToExtension("Input.dispatchKeyEvent", { type: "keyDown", ...down }, sessionId);
  await sendToExtension("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

async function handleTabs(_req, res) {
  const tabs = [];
  for (const t of pageTargets()) {
    tabs.push({ id: t.targetId, sessionId: t.sessionId, title: t.targetInfo?.title || "", url: t.targetInfo?.url || "" });
  }
  jsonResponse(res, 200, { ok: true, tabs });
}

async function handleConsole(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const tabId = url.searchParams.get("tabId") || undefined;
  const level = url.searchParams.get("level") || undefined;
  const clear = url.searchParams.get("clear") === "true";
  const limit = boundedNumber(url.searchParams.get("limit"), 100, 0, 1_000);

  if (tabId) {
    await Promise.all(sessionsForTargetScope(tabId).map((sessionId) => enableConsoleCapture(sessionId).catch(() => {})));
  } else {
    await Promise.all([...connectedTargets.keys()].map((sessionId) => enableConsoleCapture(sessionId).catch(() => {})));
  }

  let entries = consoleEntries;
  if (tabId) entries = entries.filter((entry) => entryMatchesTarget(entry, tabId));
  if (level) entries = entries.filter((entry) => entry.level === level);
  const matchedTotal = entries.length;
  const selected = limit === 0 ? [] : entries.slice(-limit);

  if (clear) {
    const ids = new Set(selected.map((entry) => entry.id));
    consoleEntries = consoleEntries.filter((entry) => !ids.has(entry.id));
  }

  jsonResponse(res, 200, { ok: true, entries: selected, count: selected.length, total: matchedTotal, storedTotal: consoleEntries.length });
}

async function handleConsoleClear(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const tabId = body.tabId;
  const level = body.level;
  const before = consoleEntries.length;
  consoleEntries = consoleEntries.filter((entry) => {
    if (tabId && !entryMatchesTarget(entry, tabId)) return true;
    if (level && entry.level !== level) return true;
    return false;
  });
  jsonResponse(res, 200, { ok: true, cleared: before - consoleEntries.length, total: consoleEntries.length });
}

async function handleNetwork(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const tabId = url.searchParams.get("tabId") || undefined;
  const type = url.searchParams.get("type") || undefined;
  const method = url.searchParams.get("method") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const requestId = url.searchParams.get("requestId") || undefined;
  const urlIncludes = url.searchParams.get("url") || url.searchParams.get("urlIncludes") || undefined;
  const clear = url.searchParams.get("clear") === "true";
  const limit = boundedNumber(url.searchParams.get("limit"), 100, 0, MAX_NETWORK_ENTRIES);

  if (tabId) {
    await Promise.all(sessionsForTargetScope(tabId).map((sessionId) => enableNetworkCapture(sessionId).catch(() => {})));
  } else {
    await Promise.all([...connectedTargets.keys()].map((sessionId) => enableNetworkCapture(sessionId).catch(() => {})));
  }

  let entries = networkEntries;
  if (tabId) entries = entries.filter((entry) => entryMatchesTarget(entry, tabId));
  if (type) entries = entries.filter((entry) => entry.type === type);
  if (method) entries = entries.filter((entry) => entry.method === method);
  if (status) entries = entries.filter((entry) => String(entry.status) === String(status));
  if (requestId) entries = entries.filter((entry) => entry.requestId === requestId);
  if (urlIncludes) entries = entries.filter((entry) => String(entry.url || "").includes(urlIncludes));
  const matchedTotal = entries.length;
  const selected = limit === 0 ? [] : entries.slice(-limit);

  if (clear) {
    const ids = new Set(selected.map((entry) => entry.id));
    networkEntries = networkEntries.filter((entry) => !ids.has(entry.id));
  }

  jsonResponse(res, 200, { ok: true, entries: selected, count: selected.length, total: matchedTotal, storedTotal: networkEntries.length });
}

async function handleNetworkClear(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const tabId = body.tabId;
  const type = body.type;
  const requestId = body.requestId;
  const before = networkEntries.length;
  networkEntries = networkEntries.filter((entry) => {
    if (tabId && !entryMatchesTarget(entry, tabId)) return true;
    if (type && entry.type !== type) return true;
    if (requestId && entry.requestId !== requestId) return true;
    return false;
  });
  jsonResponse(res, 200, { ok: true, cleared: before - networkEntries.length, total: networkEntries.length });
}

async function handleNavigate(req, res) {
  const body = await readBody(req);
  const url = body.url;
  if (!url || typeof url !== "string") return validationError(res, "url is required", "url");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const result = await sendToExtension("Page.navigate", { url }, sessionId);
  await new Promise((r) => setTimeout(r, 500));
  let title = "", finalUrl = url;
  try {
    const titleResult = await sendToExtension("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
    title = titleResult?.result?.value || "";
    const urlResult = await sendToExtension("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
    finalUrl = urlResult?.result?.value || url;
  } catch { /* non-critical */ }
  const target = connectedTargets.get(sessionId);
  if (target) {
    connectedTargets.set(sessionId, { ...target, targetInfo: { ...target.targetInfo, title, url: finalUrl } });
  }
  jsonResponse(res, 200, { ok: true, url: finalUrl, title, ...result });
}

async function handleEval(req, res) {
  const body = await readBody(req);
  const expression = body.expression;
  if (!expression || typeof expression !== "string") return validationError(res, "expression is required", "expression");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const returnByValue = body.returnByValue !== false;
  const result = await evaluateInFrame(sessionId, expression, { frameId: body.frameId, returnByValue, awaitPromise: true });
  jsonResponse(res, 200, { ok: true, result: result?.result || null, exceptionDetails: result?.exceptionDetails || null });
}

async function handleFrames(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const tabId = url.searchParams.get("tabId") || undefined;
  const sessionId = resolveTab(tabId);
  const frameTree = await getFrameTree(sessionId);
  const frames = flattenFrameTree(frameTree);
  const frameTargets = [];
  for (const target of connectedTargets.values()) {
    if (!isIframeTarget(target.targetInfo)) continue;
    if (target.rootSessionId !== rootSessionForSession(sessionId)) continue;
    frameTargets.push({
      frameId: target.frameId || target.targetId,
      targetId: target.targetId,
      sessionId: target.sessionId,
      url: target.targetInfo?.url || "",
      title: target.targetInfo?.title || "",
      parentTargetId: target.parentTargetId || "",
      oopif: true,
    });
  }
  const frameTargetById = new Map(frameTargets.map((target) => [target.frameId, target]));
  for (const frame of frames) {
    const target = frameTargetById.get(frame.id);
    if (target) {
      frame.oopif = true;
      frame.targetId = target.targetId;
      frame.sessionId = target.sessionId;
    }
  }
  jsonResponse(res, 200, { ok: true, frameTree, frames, frameTargets });
}

async function handleSnapshot(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const tabId = url.searchParams.get("tabId") || undefined;
  const frameId = url.searchParams.get("frameId") || undefined;
  const format = url.searchParams.get("format") || "text";
  const maxLength = boundedNumber(url.searchParams.get("maxLength"), 100000, 1, 1_000_000);
  const sessionId = resolveTab(tabId);

  if (format === "html") {
    const result = await evaluateInFrame(sessionId, "document.documentElement.outerHTML", { frameId });
    let html = result?.result?.value || "";
    const truncated = html.length > maxLength;
    if (truncated) html = html.slice(0, maxLength);
    const titleResult = await evaluateInFrame(sessionId, "document.title", { frameId });
    const urlResult = await evaluateInFrame(sessionId, "location.href", { frameId });
    return jsonResponse(res, 200, { ok: true, url: urlResult?.result?.value || "", title: titleResult?.result?.value || "", html, truncated });
  }

  const jsWithMaxLen = `var __maxLength = ${maxLength};\n${SNAPSHOT_JS}`;
  const result = await evaluateInFrame(sessionId, jsWithMaxLen, { frameId, awaitPromise: false });
  let snapshot = "", truncated = false;
  try {
    const parsed = JSON.parse(result?.result?.value || "{}");
    snapshot = parsed.snapshot || ""; truncated = parsed.truncated || false;
  } catch { snapshot = result?.result?.value || ""; }
  const titleResult = await evaluateInFrame(sessionId, "document.title", { frameId });
  const urlResult = await evaluateInFrame(sessionId, "location.href", { frameId });
  jsonResponse(res, 200, { ok: true, url: urlResult?.result?.value || "", title: titleResult?.result?.value || "", snapshot, truncated });
}

async function handleClick(req, res) {
  const body = await readBody(req);
  const locator = locatorFromBody(body, { allowText: true });
  if (!locator) return validationError(res, "selector or locator is required", "selector");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const frameId = body.frameId;
  const inputTarget = resolveFrameCommandSession(sessionId, frameId);

  const elInfo = await findElement(sessionId, locator, frameId);
  if (!elInfo.found) return jsonResponse(res, 200, elementNotFound(locator, frameId));

  const button = body.button || "left";
  const clickCount = body.doubleClick ? 2 : 1;

  await scrollElementIntoView(sessionId, locator, frameId);

  const elInfo2 = await findElement(sessionId, locator, frameId);
  const fx = Math.round(elInfo2.found ? elInfo2.x : elInfo.x);
  const fy = Math.round(elInfo2.found ? elInfo2.y : elInfo.y);

  await sendToExtension("Input.dispatchMouseEvent", { type: "mouseMoved", x: fx, y: fy }, inputTarget.sessionId);
  await sendToExtension("Input.dispatchMouseEvent", { type: "mousePressed", x: fx, y: fy, button, clickCount }, inputTarget.sessionId);
  await sendToExtension("Input.dispatchMouseEvent", { type: "mouseReleased", x: fx, y: fy, button, clickCount }, inputTarget.sessionId);

  jsonResponse(res, 200, { ok: true, clicked: true, elementText: elInfo2.text || elInfo.text || "", locator, frameId, oopif: inputTarget.oopif });
}

async function handleType(req, res) {
  const body = await readBody(req);
  const text = body.text;
  if (typeof text !== "string") return validationError(res, "text is required", "text");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const locator = locatorFromBody(body);
  const frameId = body.frameId;
  const inputTarget = resolveFrameCommandSession(sessionId, frameId);
  const submit = body.submit || false;
  const clear = body.clear || false;

  if (locator) {
    await scrollElementIntoView(sessionId, locator, frameId);
    const focusJs = elementResolverExpression(locator, `
      if (!el) return JSON.stringify({ found: false, locator: locator });
      el.focus({ preventScroll: false });
      if (${clear ? "true" : "false"}) {
        if (el.isContentEditable) {
          el.textContent = '';
        } else if ('value' in el) {
          var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor && descriptor.set) descriptor.set.call(el, '');
          else el.value = '';
        } else {
          el.textContent = '';
        }
        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }));
        } catch (_) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return JSON.stringify({ found: true, tag: el.tagName, type: el.type || '', contentEditable: !!el.isContentEditable });
    `);
    const focusResult = await evaluateInFrame(sessionId, focusJs, { frameId });
    const info = parseJsonString(focusResult?.result?.value, { found: false });
    if (!info.found) return jsonResponse(res, 200, elementNotFound(locator, frameId));
  }

  if (clear && !locator) {
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 }, inputTarget.sessionId);
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 }, inputTarget.sessionId);
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" }, inputTarget.sessionId);
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" }, inputTarget.sessionId);
  }

  await sendToExtension("Input.insertText", { text }, inputTarget.sessionId);

  if (submit) {
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, inputTarget.sessionId);
    await sendToExtension("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, inputTarget.sessionId);
  }

  jsonResponse(res, 200, { ok: true, typed: true, locator, frameId, oopif: inputTarget.oopif });
}

async function handleKey(req, res) {
  const body = await readBody(req);
  const input = normalizeKeyInput(body);
  if (!input) return errorResponse(res, 400, "key or combo is required");
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const frameId = body.frameId;
  const inputTarget = resolveFrameCommandSession(sessionId, frameId);
  await dispatchKeyPress(inputTarget.sessionId, input);
  jsonResponse(res, 200, { ok: true, pressed: true, frameId, oopif: inputTarget.oopif, ...input });
}

async function handleScreenshot(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const body = req.method === "POST" ? await readBody(req) : {};
  const tabId = body.tabId || url.searchParams.get("tabId") || undefined;
  const fullPage = body.fullPage === true || url.searchParams.get("fullPage") === "true";
  await ensureExtension();
  const sessionId = resolveTab(tabId);

  let strategy = fullPage ? "fullPageClip" : "viewport";
  let width = null;
  let height = null;
  let fallbackError = null;
  let result = null;

  if (fullPage) {
    try {
      const metrics = await sendToExtension("Page.getLayoutMetrics", {}, sessionId);
      const size = metrics?.cssContentSize || metrics?.contentSize || {};
      width = Math.ceil(positiveNumber(size.width, 0, 1, Number.MAX_SAFE_INTEGER));
      height = Math.ceil(positiveNumber(size.height, 0, 1, Number.MAX_SAFE_INTEGER));
      if (!width || !height) throw new Error("Page.getLayoutMetrics returned no content size");
      result = await sendToExtension("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      }, sessionId);
    } catch (err) {
      fallbackError = err instanceof Error ? err.message : String(err);
      strategy = "captureBeyondViewportFallback";
      result = await sendToExtension("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true }, sessionId);
    }
  } else {
    result = await sendToExtension("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }, sessionId);
  }

  const data = result?.data || "";
  jsonResponse(res, 200, { ok: true, data, format: "png", fullPage, strategy, width, height, bytes: Buffer.byteLength(data, "base64"), fallbackError });
}

async function handleScroll(req, res) {
  const body = await readBody(req);
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const frameId = body.frameId;
  const direction = body.direction || "down";
  const amount = boundedNumber(body.amount, 800, 1, 100_000);
  const js = direction === "bottom"
    ? "window.scrollTo(0, document.body.scrollHeight)"
    : direction === "top"
    ? "window.scrollTo(0, 0)"
    : `window.scrollBy(0, ${direction === "down" ? amount : -amount})`;
  await evaluateInFrame(sessionId, js, { frameId });
  jsonResponse(res, 200, { ok: true, scrolled: true, direction, frameId });
}

async function handleDownload(req, res) {
  const body = await readBody(req);
  const locator = locatorFromBody(body, { allowText: true });
  if (!locator) {
    return validationError(res, "selector or locator is required (e.g. 'img[src=...]', 'a[href=...]', or {\"role\":\"link\",\"name\":\"Download\"})", "selector");
  }
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const frameId = body.frameId;
  const result = await evaluateInFrame(sessionId, elementResolverExpression(locator, `
    if (!el) return JSON.stringify({ found: false, locator: locator });
    var url = el.src || el.href || '';
    var tag = el.tagName;
    return JSON.stringify({ found: true, url, tag });
  `), { frameId });
  const data = parseJsonString(result?.result?.value, { found: false });
  if (!data.found) return jsonResponse(res, 200, elementNotFound(locator, frameId));
  jsonResponse(res, 200, { ok: true, ...data, locator, frameId });
}

async function checkWaitCondition(sessionId, body) {
  const frameId = body.frameId;
  const checks = [];
  const locator = locatorFromBody(body);

  if (locator) {
    const visible = body.visible === true;
    const kind = locator.selector && !locator.text && !locator.role && !locator.name ? "selector" : "locator";
    checks.push({
      kind,
      run: async () => {
        const js = elementResolverExpression(locator, `
          if (!el) return JSON.stringify({ matched: false, found: false, locator: locator });
          var rect = el.getBoundingClientRect();
          var style = window.getComputedStyle(el);
          var visible = !!(rect.width || rect.height) && style.visibility !== 'hidden' && style.display !== 'none';
          return JSON.stringify({ matched: ${visible ? "visible" : "true"}, found: true, visible: visible, locator: locator, text: (el.innerText || el.textContent || el.value || '').trim().slice(0, 200) });
        `);
        const result = await evaluateInFrame(sessionId, js, { frameId });
        return parseJsonString(result?.result?.value, { matched: false });
      },
    });
  }

  if (typeof body.text === "string" && body.text) {
    checks.push({
      kind: "text",
      run: async () => {
        const js = `(function() {
          var haystack = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          return JSON.stringify({ matched: haystack.includes(${JSON.stringify(body.text)}) });
        })()`;
        const result = await evaluateInFrame(sessionId, js, { frameId });
        return parseJsonString(result?.result?.value, { matched: false });
      },
    });
  }

  if (typeof body.url === "string" && body.url) {
    checks.push({
      kind: "url",
      run: async () => {
        const js = `JSON.stringify({ matched: location.href.includes(${JSON.stringify(body.url)}), url: location.href })`;
        const result = await evaluateInFrame(sessionId, js, { frameId });
        return parseJsonString(result?.result?.value, { matched: false });
      },
    });
  }

  if (typeof body.urlRegex === "string" && body.urlRegex) {
    new RegExp(body.urlRegex);
    checks.push({
      kind: "urlRegex",
      run: async () => {
        const js = `JSON.stringify({ matched: new RegExp(${JSON.stringify(body.urlRegex)}).test(location.href), url: location.href })`;
        const result = await evaluateInFrame(sessionId, js, { frameId });
        return parseJsonString(result?.result?.value, { matched: false });
      },
    });
  }

  if (typeof body.expression === "string" && body.expression) {
    checks.push({
      kind: "expression",
      run: async () => {
        const js = `(async function() {
          var value = await (${body.expression});
          return JSON.stringify({ matched: !!value, value: value });
        })()`;
        const result = await evaluateInFrame(sessionId, js, { frameId });
        const exception = runtimeExceptionMessage(result);
        if (exception) return { matched: false, error: exception };
        return parseJsonString(result?.result?.value, { matched: false });
      },
    });
  }

  if (!checks.length) {
    throw new Error("wait requires selector, text, url, urlRegex, or expression");
  }

  const results = [];
  for (const check of checks) {
    const result = await check.run();
    results.push({ kind: check.kind, ...result });
  }
  return { matched: results.every((result) => result.matched), results };
}

async function handleWait(req, res) {
  const body = await readBody(req);
  if (!hasWaitCondition(body)) {
    return validationError(res, "wait requires selector, text, url, urlRegex, or expression");
  }
  if (typeof body.urlRegex === "string" && body.urlRegex) {
    try { new RegExp(body.urlRegex); }
    catch (err) {
      return validationError(res, `Invalid urlRegex: ${err instanceof Error ? err.message : String(err)}`, "urlRegex");
    }
  }
  await ensureExtension();
  const sessionId = resolveTab(body.tabId);
  const timeoutMs = boundedNumber(body.timeoutMs ?? body.timeout, DEFAULT_WAIT_TIMEOUT_MS, 1, MAX_WAIT_TIMEOUT_MS);
  const pollMs = boundedNumber(body.pollMs ?? body.poll, DEFAULT_WAIT_POLL_MS, 50, 10_000);
  const start = Date.now();
  let lastResult = null;

  while (Date.now() - start <= timeoutMs) {
    lastResult = await checkWaitCondition(sessionId, body);
    if (lastResult.matched) {
      return jsonResponse(res, 200, { ok: true, matched: true, elapsedMs: Date.now() - start, ...lastResult });
    }
    await sleep(pollMs);
  }

  jsonResponse(res, 200, {
    ...errorPayload("wait_timeout", `Wait timed out after ${timeoutMs}ms`, { status: 200, retryable: true, details: { timeoutMs } }),
    matched: false,
    timeout: true,
    elapsedMs: Date.now() - start,
    lastResult,
  });
}

async function handleCdp(req, res) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return errorResponse(res, 403, "CDP passthrough is only available from loopback clients", { code: "forbidden" });
  }
  const body = await readBody(req);
  const method = body.method;
  if (!method || typeof method !== "string") return validationError(res, "method is required", "method");
  await ensureExtension();
  const params = body.params && typeof body.params === "object" ? body.params : {};
  const sessionId = typeof body.sessionId === "string" && body.sessionId
    ? body.sessionId
    : resolveTab(body.tabId);
  const result = await sendToExtension(method, params, sessionId);
  jsonResponse(res, 200, { ok: true, result });
}

async function handleDownloadStart(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) return errorResponse(res, 400, "url is required");

  const options = { url };
  if (typeof body.filename === "string" && body.filename.trim()) options.filename = body.filename;
  if (body.saveAs === true) options.saveAs = true;
  if (typeof body.conflictAction === "string" && body.conflictAction.trim()) options.conflictAction = body.conflictAction;

  const result = await sendToExtension("BrowserRelay.download", options);
  jsonResponse(res, 200, { ok: true, downloadId: result?.id, ...result });
}

function downloadEventId(entry) {
  return entry.downloadId ?? entry.item?.id ?? entry.delta?.id ?? entry.id;
}

async function handleDownloads(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const limit = boundedNumber(url.searchParams.get("limit"), 100, 1, 1000);
  const query = { limit };
  for (const name of ["id", "state", "url", "filename", "query"]) {
    const value = url.searchParams.get(name);
    if (value) query[name] = value;
  }

  const result = await sendToExtension("BrowserRelay.searchDownloads", query);
  let events = downloadEntries.slice(-limit);
  if (query.id) {
    const id = Number(query.id);
    events = events.filter((entry) => Number(downloadEventId(entry)) === id);
  }

  jsonResponse(res, 200, { ok: true, downloads: result?.downloads || [], events });
}

async function handleDownloadsClear(_req, res) {
  const cleared = downloadEntries.length;
  downloadEntries = [];
  jsonResponse(res, 200, { ok: true, cleared });
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const startTime = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (path !== "/extension/status") {
    LOG.info("http.request", { method: req.method, path, remote: req.socket.remoteAddress || "unknown" });
  }

  // Health probe
  if (req.method === "HEAD" && path === "/") { res.writeHead(200); res.end(); return; }
  if (req.method === "GET" && path === "/") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("OK"); return; }

  // CORS for chrome-extension:// origins
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": origin || "*", "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "86400" });
    res.end(); return;
  }

  // /extension/status
  if (path === "/extension/status") { jsonResponse(res, 200, { connected: extensionConnected() }); return; }

  // /json/version and /json/list
  if (path === "/json/version" || path === "/json/version/") {
    const payload = { Browser: "BrowserRelay/custom", "Protocol-Version": "1.3" };
    if (extensionConnected() || connectedTargets.size > 0) {
      payload.webSocketDebuggerUrl = `ws://${RELAY_HOST}:${RELAY_PORT}/cdp`;
    }
    return jsonResponse(res, 200, payload);
  }
  if (path === "/json" || path === "/json/" || path === "/json/list" || path === "/json/list/") {
    const list = [];
    for (const t of pageTargets()) {
      list.push({ id: t.targetId, type: t.targetInfo?.type || "page", title: t.targetInfo?.title || "", url: t.targetInfo?.url || "" });
    }
    return jsonResponse(res, 200, list);
  }

  // All /api/* routes
  if (path.startsWith("/api/")) {
    if (req.method === "GET" && path === "/api/debug") {
      const tabCount = pageTargets().length;
      const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
      return jsonResponse(res, 200, { ok: true, version: RELAY_VERSION, host: RELAY_HOST, port: RELAY_PORT, connected: extensionConnected(), tabCount, uptimeSeconds });
    }

    const routeMap = {
      "GET /api/tabs": handleTabs,
      "GET /api/console": handleConsole,
      "POST /api/console/clear": handleConsoleClear,
      "GET /api/network": handleNetwork,
      "POST /api/network/clear": handleNetworkClear,
      "POST /api/navigate": handleNavigate,
      "GET /api/frames": handleFrames,
      "POST /api/eval": handleEval,
      "GET /api/snapshot": handleSnapshot,
      "POST /api/click": handleClick,
      "POST /api/type": handleType,
      "POST /api/key": handleKey,
      "GET /api/screenshot": handleScreenshot,
      "POST /api/screenshot": handleScreenshot,
      "POST /api/scroll": handleScroll,
      "POST /api/download": handleDownload,
      "POST /api/wait": handleWait,
      "POST /api/cdp": handleCdp,
      "POST /api/download/start": handleDownloadStart,
      "GET /api/downloads": handleDownloads,
      "POST /api/downloads/clear": handleDownloadsClear,
    };

    const routeKey = `${req.method} ${path}`;
    let handler = routeMap[routeKey];
    if (!handler) {
      handler = routeMap[`${req.method} ${path.replace(/\/$/, "")}`];
    }

    if (handler) {
      try { await handler(req, res); }
      catch (err) {
        const payload = normalizeError(err);
        LOG.error("api.error", { path, code: payload.code, error: payload.message });
        errorResponse(res, payload.status, payload.message, {
          code: payload.code,
          retryable: payload.retryable,
          details: payload.details,
        });
      }
      return;
    }

    return errorResponse(res, 404, `Unknown API endpoint: ${path}`, { code: "endpoint_not_found", details: { path } });
  }

  errorResponse(res, 404, "Not found", { code: "not_found", details: { path } });
});

// ---------------------------------------------------------------------------
// WebSocket upgrade
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname !== "/extension") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy(); return;
  }

  // Reject if extension already connected
  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) {
    socket.write("HTTP/1.1 409 Conflict\r\n\r\nExtension already connected");
    socket.destroy(); return;
  }

  if (extensionWs && extensionWs.readyState !== WebSocket.OPEN) {
    try { extensionWs.terminate(); } catch { /* ignore */ }
    extensionWs = null;
  }

  wss.handleUpgrade(req, socket, head, (ws) => { wss.emit("connection", ws, req); });
});

wss.on("connection", (ws, req) => {
  const remote = req?.socket?.remoteAddress || "unknown";
  extensionRemoteAddress = remote;
  extensionConnectedSince = new Date().toISOString();
  LOG.info("extension.connect", { remote, since: extensionConnectedSince });
  extensionWs = ws;
  clearGraceTimer();
  flushReconnectWaiters(true);

  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: "ping" })); }, PING_INTERVAL_MS);

  ws.on("message", (data) => { if (extensionWs !== ws) return; onExtensionMessage(data); });

  ws.on("close", (code, reason) => {
    LOG.info("extension.disconnect", { code, reason: reason ? String(reason) : "none" });
    extensionConnectedSince = null; extensionRemoteAddress = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (extensionWs !== ws) return;
    extensionWs = null;
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(relayError("extension_disconnected", "Extension disconnected", { status: 503, retryable: true }));
      pendingCommands.delete(id);
    }
    scheduleGraceCleanup();
  });

  ws.on("error", () => {});
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(RELAY_PORT, RELAY_HOST, () => {
  LOG.info("server.start", { version: RELAY_VERSION, host: RELAY_HOST, port: RELAY_PORT, wsPath: "/extension", httpApiPath: "/api/", healthPath: "/" });
  console.log(`\n========================================`);
  console.log(`Browser Relay v${RELAY_VERSION}`);
  console.log(`========================================`);
  console.log(`Listening:     ${RELAY_HOST}:${RELAY_PORT}`);
  console.log(`Extension WS:  ws://${RELAY_HOST}:${RELAY_PORT}/extension`);
  console.log(`HTTP API:      http://${RELAY_HOST}:${RELAY_PORT}/api/`);
  console.log(`Health probe:  http://${RELAY_HOST}:${RELAY_PORT}/ (HEAD or GET)`);
  console.log(`========================================`);
  console.log(`\nInstall the Browser Relay extension and point it at:`);
  console.log(`  ws://127.0.0.1:${RELAY_PORT}/extension`);
  console.log(`\nWaiting for extension connection...\n`);
});
