// server/server.ts
import "dotenv/config";
import crypto4 from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import express from "express";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// server/proxySecurity.ts
import net from "node:net";
var PROXY_FORBIDDEN_HEADERS = /* @__PURE__ */ new Set([
  "cookie",
  "set-cookie",
  "host",
  "origin",
  "referer",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer"
]);
var PROXY_MAX_RESPONSE_CHARS = 256 * 1024;
var PROXY_DEFAULT_TIMEOUT_MS = 1e4;
function bigIntToIpv4(n) {
  return `${n >> 24n & 0xffn}.${n >> 16n & 0xffn}.${n >> 8n & 0xffn}.${n & 0xffn}`;
}
function parseIpv6ToBigInt(raw) {
  const noZone = raw.split("%")[0];
  let work = noZone;
  const lastColon = work.lastIndexOf(":");
  if (lastColon !== -1 && work.slice(lastColon + 1).includes(".")) {
    const octets = parseIpv4Octets(work.slice(lastColon + 1));
    if (!octets) return null;
    const hi = (octets[0] << 8 | octets[1]).toString(16);
    const lo = (octets[2] << 8 | octets[3]).toString(16);
    work = `${work.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = work.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  let val = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    val = val << 16n | BigInt(parseInt(g, 16));
  }
  return val;
}
function parseIpv4Octets(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}
function isPrivateOrReservedIP(rawIp) {
  const ip = rawIp.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!ip) return true;
  const version = net.isIP(ip);
  if (version === 4) {
    const o = parseIpv4Octets(ip);
    if (!o) return true;
    const [a, b] = o;
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && o[2] === 0) return true;
    if (a === 192 && b === 0 && o[2] === 2) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const v6 = parseIpv6ToBigInt(ip);
    if (v6 === null) return true;
    if (v6 === 0n || v6 === 1n) return true;
    if (v6 >> 32n === 0xffffn || v6 >> 32n === 0n) {
      const v4 = bigIntToIpv4(v6 & 0xffffffffn);
      return isPrivateOrReservedIP(v4);
    }
    if (v6 >> 32n === 0x0064ff9b0000000000000000n) {
      return isPrivateOrReservedIP(bigIntToIpv4(v6 & 0xffffffffn));
    }
    if (v6 >> 112n === 0x2002n) {
      return isPrivateOrReservedIP(bigIntToIpv4(v6 >> 80n & 0xffffffffn));
    }
    if (v6 >> 64n === 0x0100000000000000n) return true;
    const top16 = Number(v6 >> 112n);
    if ((top16 & 65024) === 64512) return true;
    if ((top16 & 65472) === 65152) return true;
    if ((top16 & 65280) === 65280) return true;
    return false;
  }
  return true;
}
function parseAllowedHosts(raw) {
  if (!raw) return [];
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter((h) => h.length > 0);
}
function hostMatchesAllowlist(hostname, allowlist) {
  const host = hostname.trim().toLowerCase();
  if (!host || allowlist.length === 0) return false;
  return allowlist.some((allowed) => allowed === "*" || host === allowed || host.endsWith(`.${allowed}`));
}
function validateProxyTargetUrl(rawUrl, config = {}) {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed) {
    return { ok: false, status: 400, error: "\u7F3A\u5C11\u76EE\u6807\u8BF7\u6C42 URL" };
  }
  if (/[\r\n\0]/.test(trimmed)) {
    return { ok: false, status: 400, error: "URL \u5305\u542B\u975E\u6CD5\u63A7\u5236\u5B57\u7B26" };
  }
  let resolvedStr = trimmed;
  let upstreamHost = "";
  const upstreamBase = (config.upstreamBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (upstreamBase) {
    try {
      upstreamHost = new URL(upstreamBase).hostname.toLowerCase();
    } catch {
      upstreamHost = "";
    }
  }
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    if (!upstreamBase) {
      return {
        ok: false,
        status: 400,
        error: "\u670D\u52A1\u7AEF\u5C1A\u672A\u914D\u7F6E PROXY_UPSTREAM_BASE_URL\uFF0C\u76F8\u5BF9\u8DEF\u5F84\u6682\u4E0D\u53EF\u7528\uFF08\u8BF7\u8F93\u5165\u5B8C\u6574 https:// \u5730\u5740\u6216\u5728\u73AF\u5883\u53D8\u91CF\u4E2D\u914D\u7F6E\u4E0A\u6E38\u5730\u5740\uFF09"
      };
    }
    resolvedStr = `${upstreamBase}${trimmed}`;
  }
  let parsed;
  try {
    parsed = new URL(resolvedStr);
  } catch {
    return { ok: false, status: 400, error: "\u76EE\u6807 URL \u683C\u5F0F\u65E0\u6548" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, status: 400, error: "\u670D\u52A1\u7AEF\u4EE3\u7406\u4EC5\u652F\u6301 http:// \u6216 https:// \u534F\u8BAE" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, status: 400, error: "\u7981\u6B62\u5728 URL \u4E2D\u5D4C\u5165\u8D26\u53F7\u5BC6\u7801\u51ED\u8BC1" };
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.goog") {
    return { ok: false, status: 403, error: "\u5B89\u5168\u9650\u5236\uFF1A\u7981\u6B62\u670D\u52A1\u7AEF\u4EE3\u7406\u8BBF\u95EE\u672C\u673A\u6216\u5185\u7F51\u57DF\u540D" };
  }
  if (net.isIP(host) !== 0 && isPrivateOrReservedIP(host)) {
    return { ok: false, status: 403, error: "\u5B89\u5168\u9650\u5236\uFF1A\u7981\u6B62\u670D\u52A1\u7AEF\u4EE3\u7406\u8BBF\u95EE\u5185\u7F51\u3001\u56DE\u73AF\u6216\u5143\u6570\u636E IP \u5730\u5740" };
  }
  const allowedHosts = config.allowedHosts ?? [];
  const effectiveAllowlist = upstreamHost ? Array.from(/* @__PURE__ */ new Set([...allowedHosts, upstreamHost])) : [...allowedHosts];
  if (effectiveAllowlist.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "\u5B89\u5168\u9650\u5236\uFF1A\u670D\u52A1\u7AEF\u672A\u914D\u7F6E\u4EE3\u7406\u767D\u540D\u5355 (PROXY_ALLOWED_HOSTS / PROXY_UPSTREAM_BASE_URL)\uFF0C\u5DF2\u62D2\u7EDD\u5F00\u653E\u4EE3\u7406"
    };
  }
  if (!hostMatchesAllowlist(host, effectiveAllowlist)) {
    return {
      ok: false,
      status: 403,
      error: `\u5B89\u5168\u9650\u5236\uFF1A\u76EE\u6807\u57DF\u540D ${host} \u4E0D\u5728\u670D\u52A1\u7AEF\u5141\u8BB8\u4EE3\u7406\u7684\u767D\u540D\u5355 (PROXY_ALLOWED_HOSTS) \u5185`
    };
  }
  const injectSecret = upstreamBase ? host === upstreamHost : allowedHosts.some((allowed) => allowed !== "*" && (host === allowed || host.endsWith(`.${allowed}`)));
  return {
    ok: true,
    url: parsed,
    injectSecret
  };
}
function sanitizeProxyHeaders(rawHeaders) {
  const clean = {};
  if (!rawHeaders || typeof rawHeaders !== "object" || Array.isArray(rawHeaders)) {
    return { ok: true, headers: clean };
  }
  for (const [k, v] of Object.entries(rawHeaders)) {
    const key = k.trim();
    if (!key) continue;
    if (/[\r\n\0]/.test(key) || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) {
      return { ok: false, error: `\u65E0\u6548\u7684\u8BF7\u6C42\u5934\u540D\u79F0\uFF1A${key}` };
    }
    const lower = key.toLowerCase();
    if (PROXY_FORBIDDEN_HEADERS.has(lower) || lower.startsWith("sec-") || lower.startsWith("proxy-")) {
      return { ok: false, error: `\u5B89\u5168\u9650\u5236\uFF1A\u7981\u6B62\u8F6C\u53D1\u53D7\u4FDD\u62A4\u8BF7\u6C42\u5934 ${key}` };
    }
    const val = typeof v === "string" ? v : String(v ?? "");
    if (/[\r\n\0]/.test(val)) {
      return { ok: false, error: `\u8BF7\u6C42\u5934 ${key} \u5305\u542B\u975E\u6CD5\u6362\u884C\u7B26` };
    }
    clean[key] = val;
  }
  return { ok: true, headers: clean };
}
function sanitizeBinaryProxyContentType(raw) {
  const normalized = (raw || "").split(";")[0].trim().toLowerCase();
  if (normalized === "application/pdf" || normalized === "application/octet-stream") {
    return normalized;
  }
  return "application/pdf";
}

// server/pdfUnpack.ts
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var MAX_UNPACKED_DOCS = 15;
var MAX_CACHED_PAGE_IMAGES = 80;
var MAX_UNPACKED_TOTAL_BYTES = 256 * 1024 * 1024;
var MAX_RENDER_PAGES = 500;
var UNPACK_TIMEOUT_MS = 3e4;
var unpackedStore = /* @__PURE__ */ new Map();
var inFlightPageRenders = /* @__PURE__ */ new Map();
var globalCachedBytes = 0;
function evictGlobalIfNeeded(keepDocId, keepPageKey) {
  while (unpackedStore.size > MAX_UNPACKED_DOCS || globalCachedBytes > MAX_UNPACKED_TOTAL_BYTES && unpackedStore.size > 1) {
    let victimKey;
    for (const k of unpackedStore.keys()) {
      if (k !== keepDocId) {
        victimKey = k;
        break;
      }
    }
    if (!victimKey) break;
    const victim = unpackedStore.get(victimKey);
    unpackedStore.delete(victimKey);
    if (victim) {
      globalCachedBytes = Math.max(0, globalCachedBytes - victim.totalBytes);
    }
  }
  if (globalCachedBytes > MAX_UNPACKED_TOTAL_BYTES && keepDocId) {
    const rec = unpackedStore.get(keepDocId);
    if (rec) {
      for (const key of Array.from(rec.pageCache.keys())) {
        if (globalCachedBytes <= MAX_UNPACKED_TOTAL_BYTES) break;
        if (key === keepPageKey || rec.pageCache.size <= 1) continue;
        const evicted = rec.pageCache.get(key);
        rec.pageCache.delete(key);
        if (evicted) {
          rec.totalBytes = Math.max(rec.pdfBytes.byteLength, rec.totalBytes - evicted.byteLength);
          globalCachedBytes = Math.max(0, globalCachedBytes - evicted.byteLength);
        }
      }
    }
  }
}
function touchDocLru(docId, record) {
  unpackedStore.delete(docId);
  unpackedStore.set(docId, record);
  evictGlobalIfNeeded(docId);
}
function normalizePdfDpi(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 220;
  if (n <= 170) return 150;
  if (n <= 250) return 220;
  if (n <= 340) return 300;
  return 400;
}
function isPdfMagicHeader(buf) {
  if (!buf || buf.byteLength < 5) return false;
  const head = buf.subarray(0, Math.min(1024, buf.byteLength)).toString("latin1");
  return head.includes("%PDF-");
}
async function detectPdfTotalPages(inputPath, pdfBytes) {
  try {
    const { stdout } = await execFileAsync("pdfinfo", [inputPath], {
      timeout: 1e4,
      maxBuffer: 1024 * 1024
    });
    const m = stdout.match(/^Pages:\s*(\d+)/m);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.min(MAX_RENDER_PAGES, n);
    }
  } catch {
  }
  try {
    const { stdout } = await execFileAsync("mutool", ["info", inputPath], {
      timeout: 1e4,
      maxBuffer: 1024 * 1024
    });
    const m = stdout.match(/^Pages:\s*(\d+)/m);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return Math.min(MAX_RENDER_PAGES, n);
    }
  } catch {
  }
  const text = pdfBytes.toString("latin1");
  const counts = [];
  const pagesRe = /\/Type\s*\/Pages\b[\s\S]{0,4096}?\/Count\s+(\d+)/g;
  let match;
  while ((match = pagesRe.exec(text)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0 && n <= MAX_RENDER_PAGES) counts.push(n);
  }
  if (counts.length > 0) return Math.max(...counts);
  const leafMatches = text.match(/\/Type\s*\/Page\b(?!s)/g);
  if (leafMatches && leafMatches.length > 0) return Math.min(MAX_RENDER_PAGES, leafMatches.length);
  return 1;
}
async function renderSinglePageToPng(pdfBytes, pageNumber, dpi) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-pdf-page-"));
  const inputPath = path.join(tmpDir, "input.pdf");
  const outPrefix = path.join(tmpDir, "page");
  const outPng = `${outPrefix}.png`;
  try {
    await fs.writeFile(inputPath, pdfBytes);
    try {
      await execFileAsync(
        "pdftoppm",
        [
          "-png",
          "-r",
          String(dpi),
          "-f",
          String(pageNumber),
          "-l",
          String(pageNumber),
          "-singlefile",
          inputPath,
          outPrefix
        ],
        { timeout: UNPACK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
      );
    } catch {
      await execFileAsync(
        "mutool",
        ["draw", "-F", "png", "-r", String(dpi), "-o", outPng, inputPath, String(pageNumber)],
        { timeout: UNPACK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
      );
    }
    return await fs.readFile(outPng);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
}
async function unpackPdfBufferToPages(pdfBytes) {
  if (!isPdfMagicHeader(pdfBytes)) {
    throw new Error("\u65E0\u6548\u7684 PDF \u6587\u4EF6\uFF08\u7F3A\u5C11 %PDF- \u6587\u4EF6\u5934\uFF09");
  }
  const docId = crypto.randomBytes(8).toString("hex");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `atlas-pdf-meta-${docId}-`));
  const inputPath = path.join(tmpDir, "input.pdf");
  let totalPages = 1;
  try {
    await fs.writeFile(inputPath, pdfBytes);
    totalPages = await detectPdfTotalPages(inputPath, pdfBytes);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {
    });
  }
  const firstPagePng = await renderSinglePageToPng(pdfBytes, 1, 220);
  const pageCache = /* @__PURE__ */ new Map();
  pageCache.set("1@220", firstPagePng);
  const totalBytes = pdfBytes.byteLength + firstPagePng.byteLength;
  const record = {
    docId,
    pdfBytes,
    totalPages,
    pageCache,
    totalBytes,
    createdAt: Date.now()
  };
  globalCachedBytes += totalBytes;
  touchDocLru(docId, record);
  return { docId, totalPages };
}
function getUnpackedPdfMeta(docId) {
  const rec = unpackedStore.get(docId);
  if (!rec) return null;
  touchDocLru(docId, rec);
  return { docId: rec.docId, totalPages: rec.totalPages };
}
async function getUnpackedPdfPage(docId, page, requestedDpi) {
  const rec = unpackedStore.get(docId);
  if (!rec) return null;
  const pageNum = Math.floor(page);
  if (!Number.isFinite(pageNum) || pageNum < 1 || pageNum > rec.totalPages) return null;
  touchDocLru(docId, rec);
  const dpi = normalizePdfDpi(requestedDpi);
  const cacheKey = `${pageNum}@${dpi}`;
  const cached = rec.pageCache.get(cacheKey);
  if (cached) {
    rec.pageCache.delete(cacheKey);
    rec.pageCache.set(cacheKey, cached);
    return { buffer: cached, totalPages: rec.totalPages, dpi };
  }
  const flightKey = `${docId}:${cacheKey}`;
  let renderPromise = inFlightPageRenders.get(flightKey);
  if (!renderPromise) {
    renderPromise = renderSinglePageToPng(rec.pdfBytes, pageNum, dpi).finally(() => {
      inFlightPageRenders.delete(flightKey);
    });
    inFlightPageRenders.set(flightKey, renderPromise);
  }
  const rendered = await renderPromise;
  if (unpackedStore.get(docId) === rec) {
    const prevBuf = rec.pageCache.get(cacheKey);
    if (prevBuf) {
      rec.totalBytes = Math.max(rec.pdfBytes.byteLength, rec.totalBytes - prevBuf.byteLength);
      globalCachedBytes = Math.max(0, globalCachedBytes - prevBuf.byteLength);
      rec.pageCache.delete(cacheKey);
    }
    rec.pageCache.set(cacheKey, rendered);
    rec.totalBytes += rendered.byteLength;
    globalCachedBytes += rendered.byteLength;
    while (rec.pageCache.size > MAX_CACHED_PAGE_IMAGES) {
      const oldest = rec.pageCache.keys().next().value;
      if (!oldest) break;
      const evicted = rec.pageCache.get(oldest);
      rec.pageCache.delete(oldest);
      if (evicted) {
        rec.totalBytes = Math.max(rec.pdfBytes.byteLength, rec.totalBytes - evicted.byteLength);
        globalCachedBytes = Math.max(0, globalCachedBytes - evicted.byteLength);
      }
    }
    evictGlobalIfNeeded(docId, cacheKey);
  }
  return { buffer: rendered, totalPages: rec.totalPages, dpi };
}

// server/roomServer.ts
import { WebSocketServer } from "ws";

// src/core/roomPath.ts
var DEFAULT_ROOM_PATH = "atlas-main";
var MAX_ROOM_PATH_LEN = 120;
function normalizeRoomPath(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return DEFAULT_ROOM_PATH;
  const rawSegments = input.split("/");
  const cleanSegments = [];
  for (const seg of rawSegments) {
    if (!seg) continue;
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      decoded = seg;
    }
    const trimmed = decoded.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") continue;
    const safe = trimmed.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!safe || safe === "." || safe === "..") continue;
    cleanSegments.push(safe);
  }
  if (cleanSegments.length === 0) return DEFAULT_ROOM_PATH;
  const joined = cleanSegments.join("/").slice(0, MAX_ROOM_PATH_LEN).replace(/\/+$/, "");
  return joined || DEFAULT_ROOM_PATH;
}
function extractRoomPathFromWsPathname(pathname, wsPrefix = "/ws", queryRoom) {
  const prefix = wsPrefix.endsWith("/") && wsPrefix.length > 1 ? wsPrefix.slice(0, -1) : wsPrefix;
  const cleanPath = String(pathname || "/");
  if (cleanPath === prefix || cleanPath === `${prefix}/`) {
    const q = String(queryRoom ?? "").trim();
    if (!q) return { matched: true, roomPath: null };
    return { matched: true, roomPath: normalizeRoomPath(q) };
  }
  if (cleanPath.startsWith(`${prefix}/`)) {
    const sub = cleanPath.slice(prefix.length + 1);
    if (!sub.trim()) return { matched: true, roomPath: null };
    return { matched: true, roomPath: normalizeRoomPath(sub) };
  }
  return { matched: false, roomPath: null };
}

// src/core/crdt.ts
var META_FIELDS = /* @__PURE__ */ new Set(["id", "rev", "cid", "fieldRevs"]);
function beats(incoming, current) {
  if (!incoming) return false;
  if (!current) return true;
  const ar = Number(incoming.rev) || 0;
  const cr = Number(current.rev) || 0;
  if (ar !== cr) return ar > cr;
  return String(incoming.cid || "") > String(current.cid || "");
}
function mergeRecordFieldsLWW(current, incoming) {
  if (!current) {
    return { merged: incoming, changed: true };
  }
  const curRevs = current.fieldRevs;
  const incRevs = incoming.fieldRevs;
  if (!curRevs && !incRevs) {
    if (beats(incoming, current)) {
      return { merged: incoming, changed: true };
    }
    return { merged: current, changed: false };
  }
  const nextObj = { ...current };
  const nextFieldRevs = { ...curRevs ?? {} };
  let changed = false;
  const allKeys = /* @__PURE__ */ new Set([
    ...Object.keys(current),
    ...Object.keys(incoming)
  ]);
  const curFallback = { rev: Number(current.rev) || 0, cid: String(current.cid || "") };
  const incFallback = { rev: Number(incoming.rev) || 0, cid: String(incoming.cid || "") };
  for (const key of allKeys) {
    if (META_FIELDS.has(key)) continue;
    const curVal = current[key];
    const incVal = incoming[key];
    const curStamp = curRevs?.[key] ?? curFallback;
    const incStamp = incRevs?.[key] ?? incFallback;
    const incExists = key in incoming;
    const curExists = key in current;
    if (incExists && !curExists) {
      const curKeyStamp = curRevs?.[key];
      if (!curKeyStamp || beats(incStamp, curKeyStamp)) {
        nextObj[key] = incVal;
        nextFieldRevs[key] = incStamp;
        changed = true;
      }
      continue;
    }
    if (!incExists && curExists) {
      if (beats(incFallback, curStamp)) {
        delete nextObj[key];
        nextFieldRevs[key] = incFallback;
        changed = true;
      }
      continue;
    }
    const curHasStamp = Boolean(curRevs?.[key]);
    const incHasStamp = Boolean(incRevs?.[key]);
    const incWins = curHasStamp && !incHasStamp ? false : !curHasStamp && incHasStamp ? true : beats(incStamp, curStamp);
    if (incWins) {
      if (JSON.stringify(curVal) !== JSON.stringify(incVal)) {
        nextObj[key] = incVal;
        changed = true;
      }
      if (!curRevs?.[key] || beats(incStamp, curRevs[key])) {
        nextFieldRevs[key] = incStamp;
      }
    } else if (!nextFieldRevs[key]) {
      nextFieldRevs[key] = curStamp;
    }
  }
  const winMeta = beats(incoming, current) ? incoming : current;
  const maxRev = Math.max(Number(current.rev) || 0, Number(incoming.rev) || 0);
  nextObj.id = current.id;
  nextObj.rev = maxRev;
  nextObj.cid = winMeta.cid;
  nextObj.fieldRevs = nextFieldRevs;
  return { merged: nextObj, changed };
}

// server/authSession.ts
import crypto2 from "node:crypto";
function toBase64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(raw) {
  if (!raw || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const pad = raw.length % 4 === 0 ? "" : "=".repeat(4 - raw.length % 4);
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    return Buffer.from(b64, "base64");
  } catch {
    return null;
  }
}
function issueSignedSessionToken(secret, subject, ttlSec = 3600, nowMs = Date.now()) {
  const safeTtl = Math.max(1, Math.floor(ttlSec));
  const payload = {
    sub: String(subject || "anonymous").slice(0, 120),
    exp: Math.floor(nowMs / 1e3) + safeTtl
  };
  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = crypto2.createHmac("sha256", secret).update(payloadB64).digest();
  return `${payloadB64}.${toBase64Url(sig)}`;
}
function verifySignedSessionToken(secret, token, nowMs = Date.now()) {
  if (!secret || !token) return { valid: false };
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return { valid: false };
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const providedSig = fromBase64Url(sigB64);
  if (!providedSig) return { valid: false };
  const expectedSig = crypto2.createHmac("sha256", secret).update(payloadB64).digest();
  if (providedSig.length !== expectedSig.length) return { valid: false };
  if (!crypto2.timingSafeEqual(providedSig, expectedSig)) return { valid: false };
  const payloadBuf = fromBase64Url(payloadB64);
  if (!payloadBuf) return { valid: false };
  try {
    const parsed = JSON.parse(payloadBuf.toString("utf8"));
    if (typeof parsed.sub !== "string" || typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) {
      return { valid: false };
    }
    if (Math.floor(nowMs / 1e3) >= parsed.exp) {
      return { valid: false };
    }
    return { valid: true, sub: parsed.sub };
  } catch {
    return { valid: false };
  }
}
function parseCookieValue(cookieHeader, name) {
  if (!cookieHeader || !name) return "";
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq).trim();
    if (k === name) {
      const rawVal = pair.slice(eq + 1).trim();
      try {
        return decodeURIComponent(rawVal);
      } catch {
        return rawVal;
      }
    }
  }
  return "";
}
function extractWsSubprotocolToken(protocolHeader) {
  const raw = Array.isArray(protocolHeader) ? protocolHeader.join(",") : String(protocolHeader || "");
  if (!raw) return "";
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("atlas-auth.")) continue;
    const b64url = trimmed.slice("atlas-auth.".length);
    if (!b64url) continue;
    try {
      const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - b64url.length % 4) % 4);
      return Buffer.from(b64, "base64").toString("utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

// src/core/rpcBinaryFrame.ts
var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();
function encodeBinaryRpcFrame(meta, payload) {
  const headerBytes = textEncoder.encode(JSON.stringify(meta));
  const out = new Uint8Array(4 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(0, headerBytes.byteLength, false);
  out.set(headerBytes, 4);
  if (payload.byteLength > 0) {
    out.set(payload, 4 + headerBytes.byteLength);
  }
  return out;
}
function decodeBinaryRpcFrame(raw) {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(0, false);
  if (headerLen === 0 || 4 + headerLen > bytes.byteLength) return null;
  try {
    const headerStr = textDecoder.decode(bytes.subarray(4, 4 + headerLen));
    const meta = JSON.parse(headerStr);
    if (!meta || typeof meta !== "object") return null;
    return {
      meta,
      payload: bytes.subarray(4 + headerLen)
    };
  } catch {
    return null;
  }
}

// server/roomServer.ts
var COLLECTIONS = ["nodes", "annotations", "edges"];
var MAX_ROOMS = 64;
var MAX_MEMBERS_PER_ROOM = 32;
var MAX_FRAME_BYTES = 4 * 1024 * 1024;
var MAX_RPC_WS_PAYLOAD_BYTES = 72 * 1024 * 1024;
var MAX_RECORDS_PER_COLLECTION = 5e3;
var MAX_STRING_FIELD = 512 * 1024;
var HEARTBEAT_MS = 3e4;
var ROOM_IDLE_TTL_MS = 30 * 6e4;
function isVersionedRecord(value) {
  if (!value || typeof value !== "object") return false;
  const rec = value;
  if (typeof rec.id !== "string" || rec.id.length === 0 || rec.id.length > 200) return false;
  if (typeof rec.rev !== "number" || !Number.isFinite(rec.rev)) return false;
  if (typeof rec.cid !== "string" || rec.cid.length > 200) return false;
  for (const v of Object.values(rec)) {
    if (typeof v === "string" && v.length > MAX_STRING_FIELD) return false;
  }
  return true;
}
var RoomState = class {
  data = {
    nodes: /* @__PURE__ */ new Map(),
    annotations: /* @__PURE__ */ new Map(),
    edges: /* @__PURE__ */ new Map()
  };
  upsert(kind, rec) {
    const bucket = this.data[kind];
    const id = rec.id;
    const existing = bucket.get(id);
    if (!existing) {
      if (bucket.size >= MAX_RECORDS_PER_COLLECTION) return false;
      bucket.set(id, rec);
      return true;
    }
    const res = mergeRecordFieldsLWW(existing, rec);
    if (!res.changed) return false;
    bucket.set(id, res.merged);
    return true;
  }
  remove(kind, id) {
    return this.data[kind].delete(id);
  }
  replaceSnapshot(bp) {
    for (const kind of COLLECTIONS) {
      this.data[kind].clear();
      const col = bp[kind];
      if (!col || typeof col !== "object") continue;
      for (const rec of Object.values(col)) {
        if (isVersionedRecord(rec)) this.upsert(kind, rec);
      }
    }
  }
  snapshot() {
    const out = { nodes: {}, annotations: {}, edges: {} };
    for (const kind of COLLECTIONS) {
      for (const [id, rec] of this.data[kind]) out[kind][id] = rec;
    }
    return out;
  }
  get size() {
    return this.data.nodes.size + this.data.annotations.size + this.data.edges.size;
  }
};
function attachRoomServer(httpServer, wsPath = "/ws", rpcHandler, _persistDir, verifyToken, getRoomStore) {
  const rooms = /* @__PURE__ */ new Map();
  const states = /* @__PURE__ */ new Map();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RPC_WS_PAYLOAD_BYTES,
    handleProtocols: (protocols) => protocols.has("atlas-v1") ? "atlas-v1" : false
  });
  function send(socket, msg) {
    if (socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
  function broadcast(room, msg, except) {
    const targets = [];
    for (const member of room.members.values()) {
      if (member.socket !== except) targets.push(member.socket);
    }
    for (const socket of targets) {
      if (!send(socket, msg)) {
        leave(room, socket);
        try {
          socket.terminate();
        } catch {
        }
      }
    }
  }
  const idleSince = /* @__PURE__ */ new Map();
  const hydratedRooms = /* @__PURE__ */ new Set();
  const hydrationPromises = /* @__PURE__ */ new Map();
  const persistTimers = /* @__PURE__ */ new Map();
  const schedulePersistRoom = (roomName) => {
    if (!getRoomStore || roomName === "__rpc__") return;
    const prev = persistTimers.get(roomName);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      persistTimers.delete(roomName);
      const st = states.get(roomName);
      if (st) {
        const snap = st.snapshot();
        const store = getRoomStore(roomName);
        void store.writeBlueprint(snap).then(() => store.recordHistory("collab", { summary: "\u534F\u540C\u589E\u91CF\u81EA\u52A8\u4FDD\u5B58", blueprint: snap })).catch(() => {
        });
      }
    }, 600);
    timer.unref?.();
    persistTimers.set(roomName, timer);
  };
  function leave(room, socket) {
    const member = room.members.get(socket);
    if (!member) return;
    room.members.delete(socket);
    broadcast(room, { t: "peer_left", cid: member.cid });
    if (room.members.size === 0) idleSince.set(room.name, Date.now());
  }
  function join(roomName, socket, cid) {
    let room = rooms.get(roomName);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) return null;
      room = { name: roomName, members: /* @__PURE__ */ new Map() };
      rooms.set(roomName, room);
      if (!states.has(roomName)) states.set(roomName, new RoomState());
    }
    if (room.members.size >= MAX_MEMBERS_PER_ROOM) return null;
    room.members.set(socket, { socket, cid, alive: true });
    idleSince.delete(roomName);
    return room;
  }
  function handleMessage(socket, room, raw, clientIp) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send(socket, { t: "error", error: "\u6D88\u606F\u4E0D\u662F\u5408\u6CD5 JSON" });
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") {
      send(socket, { t: "error", error: "\u7F3A\u5C11\u6D88\u606F\u7C7B\u578B t" });
      return;
    }
    if (msg.t !== "rpc_req" && Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) {
      send(socket, { t: "error", error: "\u534F\u540C\u6D88\u606F\u8D85\u8FC7 4MB \u5355\u5E27\u4E0A\u9650" });
      return;
    }
    if (!room.members.has(socket)) {
      send(socket, { t: "error", error: "\u5C1A\u672A\u52A0\u5165\u623F\u95F4" });
      return;
    }
    const state = states.get(room.name);
    if (!state) {
      send(socket, { t: "error", error: "\u623F\u95F4\u72B6\u6001\u4E0D\u5B58\u5728" });
      return;
    }
    switch (msg.t) {
      case "state": {
        const bp = msg.blueprint;
        if (!bp || typeof bp !== "object") {
          send(socket, { t: "error", error: "state \u7F3A\u5C11 blueprint" });
          return;
        }
        const incoming = bp;
        let changed = false;
        for (const kind of COLLECTIONS) {
          const src = incoming[kind];
          if (!src || typeof src !== "object") continue;
          let count = 0;
          for (const rec of Object.values(src)) {
            if (count >= MAX_RECORDS_PER_COLLECTION) break;
            if (!isVersionedRecord(rec)) continue;
            if (state.upsert(kind, rec)) changed = true;
            count += 1;
          }
        }
        if (changed) {
          schedulePersistRoom(room.name);
          broadcast(room, { t: "state", blueprint: state.snapshot() }, socket);
        }
        return;
      }
      case "upsert_node":
      case "upsert_ann":
      case "upsert_edge": {
        const field = msg.t === "upsert_node" ? "node" : msg.t === "upsert_ann" ? "annotation" : "edge";
        const kind = msg.t === "upsert_node" ? "nodes" : msg.t === "upsert_ann" ? "annotations" : "edges";
        const rec = msg[field];
        if (!isVersionedRecord(rec)) {
          send(socket, { t: "error", error: `${field} \u5B57\u6BB5\u4E0D\u5408\u6CD5` });
          return;
        }
        if (!state.upsert(kind, rec)) {
          return;
        }
        schedulePersistRoom(room.name);
        broadcast(room, msg, socket);
        return;
      }
      case "delete_node":
      case "delete_ann":
      case "delete_edge": {
        const kind = msg.t === "delete_node" ? "nodes" : msg.t === "delete_ann" ? "annotations" : "edges";
        const id = msg.id;
        if (typeof id !== "string" || !id) {
          send(socket, { t: "error", error: "delete \u7F3A\u5C11 id" });
          return;
        }
        state.remove(kind, id);
        schedulePersistRoom(room.name);
        broadcast(room, msg, socket);
        return;
      }
      case "hello":
        return;
      case "rpc_req": {
        const rawFrame = msg;
        if (typeof rawFrame.id !== "string" || !rawFrame.id) {
          send(socket, { t: "error", error: "rpc_req \u7F3A\u5C11 id" });
          return;
        }
        const frame = { ...rawFrame, clientIp };
        if (!rpcHandler) {
          send(socket, {
            t: "rpc_res",
            id: frame.id,
            status: 501,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ ok: false, error: "\u670D\u52A1\u7AEF\u672A\u542F\u7528 RPC \u8F6C\u53D1" }),
            bodyEncoding: "text"
          });
          return;
        }
        void rpcHandler(frame).then((res) => {
          if (res.bodyEncoding === "binary" && res.rawBody) {
            if (socket.readyState === 1) {
              const bin = encodeBinaryRpcFrame(
                {
                  t: "rpc_res",
                  id: res.id,
                  status: res.status,
                  headers: res.headers,
                  bodyEncoding: "binary"
                },
                res.rawBody
              );
              socket.send(bin);
            }
            return;
          }
          send(socket, res);
        }).catch((err) => {
          send(socket, {
            t: "rpc_res",
            id: frame.id,
            status: 500,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({
              ok: false,
              error: `RPC \u5904\u7406\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`
            }),
            bodyEncoding: "text"
          });
        });
        return;
      }
      case "rtc_offer":
      case "rtc_answer":
      case "rtc_ice": {
        const senderCid = room.members.get(socket)?.cid || "";
        const toCid = typeof msg.to === "string" ? msg.to.trim() : "";
        if (!senderCid || !toCid || toCid === senderCid) return;
        for (const member of room.members.values()) {
          if (member.cid === toCid) {
            send(member.socket, { ...msg, from: senderCid });
            break;
          }
        }
        return;
      }
      default:
        send(socket, { t: "error", error: `\u672A\u77E5\u6D88\u606F\u7C7B\u578B\uFF1A${msg.t}` });
    }
  }
  httpServer.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    const parsedRoom = extractRoomPathFromWsPathname(url.pathname, wsPath, url.searchParams.get("room"));
    if (!parsedRoom.matched) {
      if (httpServer.listenerCount("upgrade") > 1) return;
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (verifyToken) {
      const headerToken = Array.isArray(req.headers["x-proxy-token"]) ? req.headers["x-proxy-token"][0] : req.headers["x-proxy-token"];
      const cookieToken = parseCookieValue(req.headers.cookie, "atlas_session");
      const subprotocolToken = extractWsSubprotocolToken(req.headers["sec-websocket-protocol"]);
      const providedToken = String(headerToken || cookieToken || subprotocolToken || "").trim();
      if (!verifyToken(providedToken)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    const roomName = (parsedRoom.roomPath || "").trim();
    const cid = (url.searchParams.get("cid") || "").trim();
    if (!roomName || roomName.length > 100) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!cid || cid.length > 100) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const trustProxy = String(process.env.TRUST_PROXY || "").trim().toLowerCase() === "true" || process.env.TRUST_PROXY === "1";
    const fwd = trustProxy ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
    const clientIp = fwd || req.socket.remoteAddress || "unknown";
    wss.handleUpgrade(req, socket, head, (ws) => {
      const room = join(roomName, ws, cid);
      if (!room) {
        try {
          ws.send(JSON.stringify({ t: "error", error: "\u623F\u95F4\u5DF2\u6EE1\u6216\u8FBE\u5230\u623F\u95F4\u6570\u91CF\u4E0A\u9650" }));
        } catch {
        }
        ws.close();
        return;
      }
      const state = states.get(roomName);
      if (state && state.size > 0) {
        send(ws, { t: "state", blueprint: state.snapshot() });
      } else if (roomName !== "__rpc__" && !hydratedRooms.has(roomName) && !hydrationPromises.has(roomName)) {
        const hydrateTask = (async () => {
          const initialBp = getRoomStore ? await getRoomStore(roomName).readBlueprint().catch(() => null) : null;
          if (initialBp && typeof initialBp === "object" && state) {
            const bpObj = initialBp;
            let restored = false;
            for (const kind of COLLECTIONS) {
              const col = bpObj[kind];
              if (!col || typeof col !== "object") continue;
              for (const rec of Object.values(col)) {
                if (isVersionedRecord(rec) && state.upsert(kind, rec)) restored = true;
              }
            }
            if (restored && state.size > 0) {
              const snapMsg = { t: "state", blueprint: state.snapshot() };
              for (const m of room.members.values()) {
                send(m.socket, snapMsg);
              }
            }
          }
          hydratedRooms.add(roomName);
        })().finally(() => {
          hydrationPromises.delete(roomName);
        });
        hydrationPromises.set(roomName, hydrateTask);
      }
      if (room.name !== "__rpc__") {
        const existingPeers = [...room.members.values()].map((m) => m.cid).filter((c) => c !== cid);
        if (existingPeers.length > 0) {
          send(ws, { t: "peers", peers: existingPeers });
        }
      }
      broadcast(room, { t: "peer_joined", cid }, ws);
      ws.on("message", (data, isBinary) => {
        const member = room.members.get(ws);
        if (member) member.alive = true;
        if (isBinary) {
          if (room.name !== "__rpc__") {
            send(ws, { t: "error", error: "\u666E\u901A\u534F\u540C\u623F\u95F4\u4E0D\u63A5\u53D7\u4E8C\u8FDB\u5236\u5E27" });
            return;
          }
          const rawBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const decoded = decodeBinaryRpcFrame(rawBuf);
          if (!decoded || decoded.meta.t !== "rpc_req") {
            send(ws, { t: "error", error: "\u4E8C\u8FDB\u5236 RPC \u5E27\u683C\u5F0F\u65E0\u6548" });
            return;
          }
          const binFrame = {
            t: "rpc_req",
            id: String(decoded.meta.id || ""),
            method: String(decoded.meta.method || "GET"),
            path: String(decoded.meta.path || "/"),
            headers: decoded.meta.headers || void 0,
            rawBody: decoded.payload,
            bodyEncoding: "binary",
            clientIp
          };
          if (!binFrame.id) {
            send(ws, { t: "error", error: "rpc_req \u7F3A\u5C11 id" });
            return;
          }
          if (!rpcHandler) {
            send(ws, {
              t: "rpc_res",
              id: binFrame.id,
              status: 501,
              headers: { "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ ok: false, error: "\u670D\u52A1\u7AEF\u672A\u542F\u7528 RPC \u8F6C\u53D1" }),
              bodyEncoding: "text"
            });
            return;
          }
          void rpcHandler(binFrame).then((res) => {
            if (res.bodyEncoding === "binary" && res.rawBody && ws.readyState === 1) {
              ws.send(
                encodeBinaryRpcFrame(
                  { t: "rpc_res", id: res.id, status: res.status, headers: res.headers, bodyEncoding: "binary" },
                  res.rawBody
                )
              );
              return;
            }
            send(ws, res);
          }).catch((err) => {
            send(ws, {
              t: "rpc_res",
              id: binFrame.id,
              status: 500,
              headers: { "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify({ ok: false, error: `RPC \u5904\u7406\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}` }),
              bodyEncoding: "text"
            });
          });
          return;
        }
        handleMessage(ws, room, String(data), clientIp);
      });
      ws.on("pong", () => {
        const member = room.members.get(ws);
        if (member) member.alive = true;
      });
      ws.on("close", () => leave(room, ws));
      ws.on("error", () => leave(room, ws));
    });
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const member of [...room.members.values()]) {
        if (!member.alive) {
          leave(room, member.socket);
          try {
            member.socket.terminate();
          } catch {
          }
          continue;
        }
        member.alive = false;
        try {
          member.socket.ping();
        } catch {
        }
      }
      if (room.members.size === 0 && !idleSince.has(room.name)) {
        idleSince.set(room.name, now);
      }
      const idleAt = idleSince.get(room.name);
      if (idleAt !== void 0 && room.members.size === 0 && now - idleAt > ROOM_IDLE_TTL_MS) {
        rooms.delete(room.name);
        states.delete(room.name);
        hydratedRooms.delete(room.name);
        hydrationPromises.delete(room.name);
        idleSince.delete(room.name);
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  return {
    stats: () => ({
      rooms: rooms.size,
      members: [...rooms.values()].reduce((sum, r) => sum + r.members.size, 0)
    }),
    async flushRoomSnapshot(roomName) {
      if (!roomName || roomName === "__rpc__") return null;
      const pendingHydration = hydrationPromises.get(roomName);
      if (pendingHydration) {
        await pendingHydration;
      }
      const st = states.get(roomName);
      if (!st) return null;
      if (!hydratedRooms.has(roomName) && !persistTimers.has(roomName)) return null;
      const timer = persistTimers.get(roomName);
      if (timer) {
        clearTimeout(timer);
        persistTimers.delete(roomName);
      }
      const snap = st.snapshot();
      if (getRoomStore && timer) {
        try {
          await getRoomStore(roomName).writeBlueprint(snap);
        } catch {
        }
      }
      return snap;
    },
    syncPublishedBlueprint(roomName, blueprint) {
      if (!roomName || roomName === "__rpc__" || !blueprint || typeof blueprint !== "object") return;
      const pendingTimer = persistTimers.get(roomName);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        persistTimers.delete(roomName);
      }
      let st = states.get(roomName);
      if (!st) {
        st = new RoomState();
        states.set(roomName, st);
      }
      st.replaceSnapshot(blueprint);
      hydratedRooms.add(roomName);
      const room = rooms.get(roomName);
      if (room) {
        broadcast(room, { t: "state", blueprint: st.snapshot(), replace: true });
      }
    },
    close: () => new Promise((resolve) => {
      clearInterval(heartbeat);
      const flushTasks = [];
      for (const [rName, t] of persistTimers.entries()) {
        clearTimeout(t);
        const st = states.get(rName);
        if (getRoomStore && st) {
          flushTasks.push(getRoomStore(rName).writeBlueprint(st.snapshot()).then(() => {
          }).catch(() => {
          }));
        }
      }
      persistTimers.clear();
      for (const room of rooms.values()) {
        for (const member of room.members.values()) {
          try {
            member.socket.close();
          } catch {
          }
        }
      }
      rooms.clear();
      states.clear();
      hydratedRooms.clear();
      hydrationPromises.clear();
      idleSince.clear();
      wss.close(() => {
        void Promise.allSettled(flushTasks).finally(() => resolve());
      });
    })
  };
}

// server/fileStore.ts
import crypto3 from "node:crypto";
import fs2 from "node:fs/promises";
import path2 from "node:path";
async function atomicWriteJson(filePath, data) {
  const dir = path2.dirname(filePath);
  await fs2.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  await fs2.writeFile(tmpPath, payload, "utf8");
  await fs2.rename(tmpPath, filePath);
}
async function safeReadJson(filePath) {
  try {
    const raw = await fs2.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function roomPathToFileKey(roomPath) {
  const normalized = normalizeRoomPath(roomPath);
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(normalized)) {
    return normalized;
  }
  const slug = normalized.replace(/\//g, "__").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "room";
  const hash = crypto3.createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${slug}__${hash}`;
}
var MAX_HISTORY_ENTRIES = 50;
function createSingleFileBlueprintStore(filePath, roomPath) {
  const historyPath = filePath.replace(/\.json$/i, ".history.json");
  let loaded = false;
  let loadPromise = null;
  let revision = 1;
  let blueprint = null;
  let historyLoaded = false;
  let historyLoadPromise = null;
  let historyEntries = [];
  let lastBlueprintJson = "";
  let writeChain = Promise.resolve();
  const ensureLoaded = async () => {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = (async () => {
        const saved = await safeReadJson(filePath);
        if (saved && typeof saved === "object") {
          const r = Number(saved.revision);
          if (Number.isFinite(r) && r >= 1) revision = Math.trunc(r);
          if (saved.blueprint !== void 0) {
            blueprint = saved.blueprint;
            try {
              lastBlueprintJson = JSON.stringify(blueprint);
            } catch {
              lastBlueprintJson = "";
            }
          }
        }
        loaded = true;
      })().finally(() => {
        loadPromise = null;
      });
    }
    await loadPromise;
  };
  const ensureHistoryLoaded = async () => {
    if (historyLoaded) return;
    if (!historyLoadPromise) {
      historyLoadPromise = (async () => {
        const saved = await safeReadJson(historyPath);
        if (Array.isArray(saved)) {
          historyEntries = saved.filter(
            (e) => e && typeof e === "object" && typeof e.version === "number" && typeof e.ts === "number"
          );
          if (historyEntries.length > MAX_HISTORY_ENTRIES) {
            historyEntries = historyEntries.slice(-MAX_HISTORY_ENTRIES);
          }
        }
        historyLoaded = true;
      })().finally(() => {
        historyLoadPromise = null;
      });
    }
    await historyLoadPromise;
  };
  const enqueuePersistMain = () => {
    const snap = {
      roomPath,
      revision,
      blueprint,
      updatedAt: Date.now()
    };
    writeChain = writeChain.then(() => atomicWriteJson(filePath, snap)).catch((err) => {
      console.error("[Atlas] persist blueprint failed:", filePath, err);
    });
    return writeChain;
  };
  const enqueuePersistHistory = () => {
    const snap = historyEntries.slice(-MAX_HISTORY_ENTRIES);
    writeChain = writeChain.then(() => atomicWriteJson(historyPath, snap)).catch((err) => {
      console.error("[Atlas] persist history failed:", historyPath, err);
    });
    return writeChain;
  };
  return {
    async readRevision() {
      await ensureLoaded();
      return revision;
    },
    async writeRevision(rev) {
      await ensureLoaded();
      revision = rev;
      await enqueuePersistMain();
    },
    async readBlueprint() {
      await ensureLoaded();
      return blueprint;
    },
    async writeBlueprint(bp) {
      await ensureLoaded();
      blueprint = bp;
      try {
        lastBlueprintJson = JSON.stringify(bp);
      } catch {
        lastBlueprintJson = "";
      }
      await enqueuePersistMain();
      return true;
    },
    async recordHistory(action, opts) {
      await ensureLoaded();
      await ensureHistoryLoaded();
      const targetBp = opts?.blueprint !== void 0 ? opts.blueprint : blueprint;
      if (!targetBp || typeof targetBp !== "object") return null;
      let serialized = "";
      try {
        serialized = JSON.stringify(targetBp);
      } catch {
        return null;
      }
      const latest = historyEntries[historyEntries.length - 1];
      if (action === "collab" && latest) {
        try {
          if (JSON.stringify(latest.blueprint) === serialized) return null;
        } catch {
        }
      }
      const nextVersion = (latest?.version ?? 0) + 1;
      const entry = {
        version: nextVersion,
        ts: Date.now(),
        action,
        actor: String(opts?.actor || "system").slice(0, 80),
        summary: String(
          opts?.summary || (action === "publish" ? "\u53D1\u5E03\u84DD\u56FE" : action === "rollback" ? "\u7248\u672C\u56DE\u6863" : "\u534F\u540C\u53D8\u66F4")
        ).slice(0, 120),
        blueprint: JSON.parse(serialized)
      };
      historyEntries.push(entry);
      if (historyEntries.length > MAX_HISTORY_ENTRIES) {
        historyEntries = historyEntries.slice(-MAX_HISTORY_ENTRIES);
      }
      await enqueuePersistHistory();
      return {
        version: entry.version,
        ts: entry.ts,
        action: entry.action,
        actor: entry.actor,
        summary: entry.summary
      };
    },
    async listHistory() {
      await ensureHistoryLoaded();
      return historyEntries.slice().reverse().map(({ version, ts, action, actor, summary }) => ({
        version,
        ts,
        action,
        actor,
        summary
      }));
    },
    async rollbackToVersion(version, actor = "admin") {
      await ensureLoaded();
      await ensureHistoryLoaded();
      const target = historyEntries.find((e) => e.version === version);
      if (!target) {
        return { ok: false, revision, blueprint, error: `\u672A\u627E\u5230\u7248\u672C v${version}` };
      }
      let cloned;
      try {
        cloned = JSON.parse(JSON.stringify(target.blueprint));
      } catch {
        cloned = target.blueprint;
      }
      blueprint = cloned;
      revision += 1;
      try {
        lastBlueprintJson = JSON.stringify(cloned);
      } catch {
        lastBlueprintJson = "";
      }
      await enqueuePersistMain();
      const latest = historyEntries[historyEntries.length - 1];
      const rollbackEntry = {
        version: (latest?.version ?? 0) + 1,
        ts: Date.now(),
        action: "rollback",
        actor: String(actor || "admin").slice(0, 80),
        summary: `\u56DE\u6863\u81F3 v${version}`,
        blueprint: JSON.parse(lastBlueprintJson || "null")
      };
      historyEntries.push(rollbackEntry);
      if (historyEntries.length > MAX_HISTORY_ENTRIES) {
        historyEntries = historyEntries.slice(-MAX_HISTORY_ENTRIES);
      }
      await enqueuePersistHistory();
      return {
        ok: true,
        revision,
        blueprint: cloned,
        entry: {
          version: rollbackEntry.version,
          ts: rollbackEntry.ts,
          action: rollbackEntry.action,
          actor: rollbackEntry.actor,
          summary: rollbackEntry.summary
        }
      };
    }
  };
}
function createRoomBlueprintStoreRegistry(dataDir, maxCachedStores = 100) {
  const cap = Math.max(1, Math.floor(maxCachedStores));
  const stores = /* @__PURE__ */ new Map();
  return {
    getStore(roomPath) {
      const normalized = normalizeRoomPath(roomPath);
      const isDefault = normalized === DEFAULT_ROOM_PATH || normalized === "default";
      const cacheKey = isDefault ? DEFAULT_ROOM_PATH : normalized;
      const existing = stores.get(cacheKey);
      if (existing) {
        stores.delete(cacheKey);
        stores.set(cacheKey, existing);
        return existing;
      }
      const targetFile = path2.join(dataDir, "rooms", `${roomPathToFileKey(cacheKey)}.json`);
      const created = createSingleFileBlueprintStore(targetFile, normalized);
      stores.set(cacheKey, created);
      while (stores.size > cap) {
        const oldest = stores.keys().next().value;
        if (oldest === void 0) break;
        stores.delete(oldest);
      }
      return created;
    },
    cachedCount() {
      return stores.size;
    }
  };
}
async function listPersistedRooms(dataDir) {
  const rooms = /* @__PURE__ */ new Set();
  const roomsDir = path2.join(dataDir, "rooms");
  try {
    const entries = await fs2.readdir(roomsDir);
    for (const name of entries) {
      if (name.endsWith(".json") && !name.endsWith(".history.json")) {
        const parsed = await safeReadJson(path2.join(roomsDir, name));
        const logical = typeof parsed?.roomPath === "string" && parsed.roomPath.trim() ? parsed.roomPath.trim() : name.slice(0, -5);
        rooms.add(logical);
      }
    }
  } catch {
  }
  return Array.from(rooms).sort();
}

// src/core/mediaHelper.ts
var SAFE_INLINE_SVG_RE = /^data:image\/svg\+xml;/i;
function isSafeImageUrl(raw) {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith("/api/")) return true;
  if (SAFE_INLINE_SVG_RE.test(s) && s.length <= 16384) return true;
  try {
    const parsed = new URL(s);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
function isSafeVideoUrl(raw) {
  const s = raw.trim();
  if (!s) return false;
  if (s.startsWith("/api/")) return true;
  try {
    const parsed = new URL(s);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// src/core/pdfHelper.ts
function isSafePdfUrl(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("blob:") || trimmed.startsWith("client-pdf://") || trimmed.startsWith("/api/pdf/") || trimmed.startsWith("/api/proxy/binary")) {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// src/core/apiPoller.ts
var MAX_BACKOFF_DELAY_MS = 5 * 60 * 1e3;
function isSafePollUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// src/core/edgePath.ts
var MAX_EDGE_CONTROL_POINTS = 12;
function sanitizeControlPoints(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_EDGE_CONTROL_POINTS) break;
    if (!item || typeof item !== "object") continue;
    const rawX = item.x;
    const rawY = item.y;
    if (typeof rawX !== "number" || typeof rawY !== "number") continue;
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) continue;
    const x = rawX;
    const y = rawY;
    out.push({ x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

// src/core/placement.ts
function rectsOverlap(a, b, gap = 0) {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
function hasAnyOverlap(candidate, existing, gap) {
  for (let i = 0; i < existing.length; i++) {
    if (rectsOverlap(candidate, existing[i], gap)) return true;
  }
  return false;
}
function findNonOverlappingPosition(desired, existing, options) {
  const gap = Math.max(0, options?.gap ?? 20);
  const step = Math.max(16, options?.step ?? 48);
  const maxRings = Math.max(2, options?.maxRings ?? 18);
  const startX = Math.round(desired.x);
  const startY = Math.round(desired.y);
  const width = Math.max(40, Math.round(desired.width));
  const height = Math.max(40, Math.round(desired.height));
  const initial = { x: startX, y: startY, width, height };
  if (existing.length === 0 || !hasAnyOverlap(initial, existing, gap)) {
    return { x: startX, y: startY };
  }
  const blockers = existing.filter((b) => rectsOverlap(initial, b, gap));
  const anchorCandidates = [];
  for (const b of blockers) {
    anchorCandidates.push(
      { x: Math.ceil(b.x + b.width + gap), y: startY },
      { x: startX, y: Math.ceil(b.y + b.height + gap) },
      { x: Math.ceil(b.x + b.width + gap), y: Math.round(b.y) },
      { x: Math.round(b.x), y: Math.ceil(b.y + b.height + gap) },
      { x: Math.floor(b.x - width - gap), y: startY },
      { x: startX, y: Math.floor(b.y - height - gap) }
    );
  }
  let bestAnchor = null;
  for (const pt of anchorCandidates) {
    if (!hasAnyOverlap({ x: pt.x, y: pt.y, width, height }, existing, gap)) {
      const dx = pt.x - startX;
      const dy = pt.y - startY;
      const bias = (dx < 0 ? 1.15 : 1) * (dy < 0 ? 1.15 : 1);
      const distSq = (dx * dx + dy * dy) * bias;
      if (!bestAnchor || distSq < bestAnchor.distSq) {
        bestAnchor = { x: pt.x, y: pt.y, distSq };
      }
    }
  }
  if (bestAnchor) {
    return { x: bestAnchor.x, y: bestAnchor.y };
  }
  const stepX = Math.max(step, Math.round((width + gap) / 3));
  const stepY = Math.max(step, Math.round((height + gap) / 3));
  for (let ring = 1; ring <= maxRings; ring++) {
    let bestInRing = null;
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gy = -ring; gy <= ring; gy++) {
        if (Math.abs(gx) !== ring && Math.abs(gy) !== ring) continue;
        const cx = startX + gx * stepX;
        const cy = startY + gy * stepY;
        if (!hasAnyOverlap({ x: cx, y: cy, width, height }, existing, gap)) {
          const dx = cx - startX;
          const dy = cy - startY;
          const distSq = dx * dx + dy * dy;
          if (!bestInRing || distSq < bestInRing.distSq) {
            bestInRing = { x: cx, y: cy, distSq };
          }
        }
      }
    }
    if (bestInRing) {
      return { x: bestInRing.x, y: bestInRing.y };
    }
  }
  let maxRight = startX;
  for (const b of existing) {
    if (b.x + b.width + gap > maxRight) maxRight = Math.ceil(b.x + b.width + gap);
  }
  return { x: maxRight, y: startY };
}

// src/core/scriptSandbox.ts
var BLOCKED_TOKENS = [
  "window",
  "document",
  "globalThis",
  "self",
  "caches",
  "EventSource",
  "BroadcastChannel",
  "setTimeout",
  "setInterval",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "cookie",
  "eval",
  "Function",
  "AsyncFunction",
  "Proxy",
  "Reflect",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "import",
  "importScripts",
  "navigator",
  "location",
  "history",
  "postMessage",
  "__proto__",
  "prototype",
  "constructor",
  "setPrototypeOf",
  "getPrototypeOf"
];
function validateScriptSafety(code) {
  if (code.length > 24576) {
    return { ok: false, reason: "\u811A\u672C\u8D85\u8FC7 24KB \u957F\u5EA6\u4E0A\u9650" };
  }
  for (const token of BLOCKED_TOKENS) {
    const re = new RegExp(`\\b${token}\\b`);
    if (re.test(code)) {
      return { ok: false, reason: `\u5B89\u5168\u62E6\u622A\uFF1A\u7981\u6B62\u5728\u63A7\u4EF6\u811A\u672C\u4E2D\u4F7F\u7528 ${token}` };
    }
  }
  return { ok: true };
}

// src/core/runtimeConfig.ts
var RAW_BACKEND_WS_URL = String((import.meta.env ?? {}).VITE_BACKEND_WS_URL ?? "").trim();
var RAW_FORCE_BACKEND_PROXY = String(
  (import.meta.env ?? {}).VITE_FORCE_BACKEND_PROXY ?? ""
).trim();
function parseForceBackendProxy(raw) {
  const norm = String(raw ?? "").trim().toLowerCase();
  if (norm === "false" || norm === "0" || norm === "off" || norm === "no") {
    return false;
  }
  return true;
}
function forceBackendProxy() {
  return parseForceBackendProxy(RAW_FORCE_BACKEND_PROXY);
}

// src/core/widgetTemplates.ts
var BUILTIN_TEMPLATES = [
  {
    id: "tpl-api-poller",
    name: "API \u8F6E\u8BE2\u6293\u53D6\u5668",
    description: "\u5B9A\u65F6\u8F6E\u8BE2\u6293\u53D6\u63A5\u53E3\u6570\u636E\u3001JSON \u8DEF\u5F84\u63D0\u53D6\u3001\u6307\u6570\u9000\u907F\u4E0E\u79BB\u5C4F\u81EA\u52A8\u6682\u505C",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#0284C7",
    nodePreset: {
      width: 390,
      height: 330,
      title: "API \u8F6E\u8BE2\u6293\u53D6\u5668",
      body: "",
      category: "\u8F6E\u8BE2",
      color: "#0284C7",
      inputPorts: [{ id: "in-1", label: "\u914D\u7F6E\u5165\u53E3" }],
      outputPorts: [{ id: "out-1", label: "\u6293\u53D6\u7ED3\u679C\u8F93\u51FA" }],
      defaultVars: {
        pollUrl: "/api/proxy/status",
        pollMethod: "GET",
        pollIntervalSec: 10,
        pollJsonPath: "",
        pollUseProxy: forceBackendProxy(),
        pollEnabled: false,
        pollLastValue: "",
        pollStatus: "",
        pollUpdatedAt: ""
      },
      script: String.raw`vars.contents = [
  {
    type: 'api_poller',
    id: 'pollerView',
    bindUrl: 'pollUrl',
    bindMethod: 'pollMethod',
    bindInterval: 'pollIntervalSec',
    bindJsonPath: 'pollJsonPath',
    bindProxy: 'pollUseProxy',
    bindEnabled: 'pollEnabled'
  }
];`
    }
  },
  {
    id: "tpl-pdf-reader",
    name: "PDF \u9605\u8BFB\u5668",
    description: "\u89E3\u5305 PDF \u4E3A\u9010\u9875\u56FE\u7247\uFF0C\u4EFF Windows \u56FE\u7247\u67E5\u770B\u5668\u5DE6\u53F3\u7FFB\u9875\u4E0E\u9875\u7801\u76F4\u8FBE\uFF08fit \u63A7\u4EF6\u5927\u5C0F \xB7 \u4E00\u6B21\u6027\u8F93\u5165\uFF09",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#DC2626",
    nodePreset: {
      width: 440,
      height: 455,
      title: "PDF \u9605\u8BFB\u5668",
      body: "",
      category: "PDF",
      color: "#DC2626",
      defaultVars: { pdfUrl: "", pdfPage: 1, pdfUseProxy: false },
      script: String.raw`const page = Math.max(1, Math.floor(Number(vars.pdfPage) || 1));
vars.contents = [
  {
    type: 'pdf',
    id: 'pdfView',
    bindUrl: 'pdfUrl',
    bindPage: 'pdfPage',
    bindProxy: 'pdfUseProxy',
    height: 300
  }
];`
    }
  },
  {
    id: "tpl-var-morph",
    name: "vars \u63A7\u5F62\u793A\u4F8B",
    description: "\u811A\u672C\u7528 vars.type / title / width / height / pos \u5B9E\u65F6\u53D8\u5F62\u4E0E\u4F4D\u79FB",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#0D9488",
    nodePreset: {
      title: "vars \u9A71\u52A8\u5F62\u6001\u793A\u4F8B",
      body: "",
      width: 380,
      height: 205,
      category: "\u5F62\u6001",
      color: "#0D9488",
      defaultVars: { modeIdx: 0, expanded: false, titleDraft: "" },
      script: String.raw`const modes = [
  { type: '形态', title: '④ vars 驱动形态演示', color: '#0D9488' },
  { type: 'ALERT', title: '告警模式（vars.type / title）', color: '#DC2626' },
  { type: 'TERM', title: '终端模式（vars.color 变色）', color: '#1E293B' }
];
const idx = Number(vars.modeIdx) || 0;
const expanded = Boolean(vars.expanded);
const w = ctx.entity.width;
const h = ctx.entity.height;
const x = ctx.entity.x;
const y = ctx.entity.y;

vars.contents = [
  { type: 'text', text: '当前：' + w + '×' + h + ' · 坐标 (' + x + ', ' + y + ')', align: 'center', color: '#0F766E', fontSize: 12, bold: true },
  [
    { type: 'input', id: 'titleInp', bind: 'titleDraft', placeholder: '输入新标题按回车直接改 vars.title…' },
    { type: 'button', id: 'applyTitle', label: '改标题', width: 68, variant: 'primary' }
  ],
  [
    { type: 'button', id: 'cycleMode', label: '切 type/色', variant: 'primary' },
    { type: 'button', id: 'toggleSize', label: expanded ? '还原宽高' : '放大宽高', variant: 'secondary' },
    { type: 'button', id: 'nudgeRight', label: 'pos.x +80', variant: 'success' },
    { type: 'button', id: 'resetAll', label: '重置', variant: 'secondary' }
  ]
];

onSubmit('titleInp', (val) => {
  const t = String(val || '').trim();
  if (t) { vars.title = t; vars.titleDraft = ''; }
});
on('applyTitle', () => {
  const t = String(vars.titleDraft || '').trim();
  if (t) { vars.title = t; vars.titleDraft = ''; }
});
on('cycleMode', () => {
  const next = (idx + 1) % modes.length;
  vars.modeIdx = next;
  vars.type = modes[next].type;
  vars.title = modes[next].title;
  vars.color = modes[next].color;
});
on('toggleSize', () => {
  const nextExp = !expanded;
  vars.expanded = nextExp;
  vars.width = nextExp ? 480 : 380;
  vars.height = nextExp ? 270 : 205;
});
on('nudgeRight', () => {
  vars.pos = { x: (ctx.entity.x ?? 960) + 80, y: ctx.entity.y ?? 1005 };
});
on('resetAll', () => {
  vars.modeIdx = 0;
  vars.expanded = false;
  vars.titleDraft = '';
  delete vars.type;
  delete vars.title;
  delete vars.color;
  delete vars.width;
  delete vars.height;
  delete vars.pos;
  delete vars.x;
  delete vars.y;
});`
    }
  },
  // 一、知识地图
  {
    id: "tpl-knowledge-card",
    name: "\u77E5\u8BC6\u6982\u5FF5\u5361",
    description: "\u8BB0\u5F55\u6838\u5FC3\u6982\u5FF5\u3001\u53C2\u8003\u8981\u70B9\u4E0E\u590D\u4E60\u719F\u7EC3\u5EA6\u8BA1\u6570",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#2563EB",
    nodePreset: {
      width: 280,
      height: 175,
      title: "\u65B0\u77E5\u8BC6\u6982\u5FF5",
      body: "\u6838\u5FC3\u5B9A\u4E49\uFF1A\n\u5173\u952E\u8981\u70B9\uFF1A\n\u5173\u8054\u4E3B\u9898\uFF1A",
      category: "\u77E5\u8BC6",
      color: "#2563EB",
      defaultVars: { reviewCount: 0, mastery: "\u5B66\u4E60\u4E2D" },
      buttons: [
        {
          id: "btn-review",
          label: "\u590D\u4E60 +1",
          variant: "primary",
          actionType: "script",
          code: `const n = lib.inc('reviewCount', 1);
vars.mastery = n >= 3 ? '\u5DF2\u638C\u63E1' : '\u5DE9\u56FA\u4E2D';
vars.lastReview = lib.now();`
        }
      ]
    }
  },
  {
    id: "tpl-milestone",
    name: "\u4EFB\u52A1 / \u91CC\u7A0B\u7891\u5361",
    description: "\u5E26\u5B8C\u6210\u8FDB\u5EA6\u4E0E\u72B6\u6001\u4E00\u952E\u5207\u6362\u7684\u8BA1\u5212\u8282\u70B9",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#059669",
    nodePreset: {
      width: 280,
      height: 175,
      title: "\u9636\u6BB5\u91CC\u7A0B\u7891",
      body: "- [ ] \u76EE\u6807\u62C6\u89E3\n- [ ] \u5173\u952E\u4EA4\u4ED8\u7269\n- [ ] \u9A8C\u6536\u6807\u51C6",
      category: "\u4EFB\u52A1",
      color: "#059669",
      defaultVars: { progress: 0, state: "\u5F85\u5F00\u59CB" },
      buttons: [
        {
          id: "btn-step",
          label: "\u8FDB\u5EA6 +25%",
          variant: "success",
          actionType: "script",
          code: `const p = Math.min(100, lib.inc('progress', 25));
vars.progress = p;
vars.state = p >= 100 ? '\u5DF2\u5B8C\u6210' : '\u8FDB\u884C\u4E2D';`
        },
        {
          id: "btn-reset-p",
          label: "\u6E05\u96F6",
          variant: "secondary",
          actionType: "script",
          code: `vars.progress = 0;
vars.state = '\u5F85\u5F00\u59CB';`
        }
      ]
    }
  },
  {
    id: "tpl-decision",
    name: "\u5BF9\u6BD4\u51B3\u7B56\u5361",
    description: "\u7528\u4E8E\u65B9\u6848\u53D6\u820D\u3001\u5229\u5F0A\u8BB0\u5F55\u4E0E\u56E2\u961F\u6295\u7968\u8BA1\u6570",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#7C3AED",
    nodePreset: {
      width: 290,
      height: 180,
      title: "\u65B9\u6848\u5BF9\u6BD4\u4E0E\u7ED3\u8BBA",
      body: "\u4F18\u70B9\uFF1A\n\u7F3A\u70B9 / \u98CE\u9669\uFF1A\n\u5F53\u524D\u7ED3\u8BBA\uFF1A",
      category: "\u51B3\u7B56",
      color: "#7C3AED",
      defaultVars: { agree: 0, reject: 0 },
      buttons: [
        {
          id: "btn-agree",
          label: "\u8D5E\u6210 +1",
          variant: "success",
          actionType: "script",
          code: `lib.inc('agree', 1);`
        },
        {
          id: "btn-reject",
          label: "\u53CD\u5BF9 +1",
          variant: "danger",
          actionType: "script",
          code: `lib.inc('reject', 1);`
        }
      ]
    }
  },
  // 二、策划与世界观
  {
    id: "tpl-world-zone",
    name: "\u4E16\u754C\u89C2 / \u533A\u57DF\u8BBE\u5B9A",
    description: "\u5927\u5730\u56FE\u7B56\u5212\u533A\u57DF\u3001\u52BF\u529B\u5206\u5E03\u4E0E\u5BA1\u9605\u72B6\u6001",
    group: "\u7B56\u5212\u4E0E\u4E16\u754C\u89C2",
    kind: "node",
    color: "#0F766E",
    nodePreset: {
      width: 290,
      height: 185,
      title: "\u672A\u547D\u540D\u533A\u57DF\u8BBE\u5B9A",
      body: "\u5730\u8C8C\u4E0E\u6C1B\u56F4\uFF1A\n\u4E3B\u5BFC\u52BF\u529B\uFF1A\n\u6838\u5FC3\u51B2\u7A81 / \u63A2\u7D22\u5956\u52B1\uFF1A",
      category: "\u4E16\u754C\u89C2",
      color: "#0F766E",
      defaultVars: { dangerLv: 1, review: "\u8349\u7A3F" },
      buttons: [
        {
          id: "btn-lv",
          label: "\u5371\u9669\u7B49\u7EA7 +1",
          variant: "secondary",
          actionType: "script",
          code: `lib.inc('dangerLv', 1);`
        },
        {
          id: "btn-pass",
          label: "\u6807\u8BB0\u7EC8\u7A3F",
          variant: "success",
          actionType: "script",
          code: `vars.review = '\u7EC8\u7A3F';
vars.approvedAt = lib.now();`
        }
      ]
    }
  },
  {
    id: "tpl-quest-node",
    name: "\u5267\u60C5 / \u5173\u5361\u8282\u70B9",
    description: "\u4E32\u8054\u4E3B\u7EBF\u652F\u7EBF\u3001\u89E6\u53D1\u6761\u4EF6\u4E0E\u901A\u5173\u5956\u52B1",
    group: "\u7B56\u5212\u4E0E\u4E16\u754C\u89C2",
    kind: "node",
    color: "#D97706",
    nodePreset: {
      width: 280,
      height: 180,
      title: "\u7B2C X \u7AE0 \xB7 \u5173\u5361\u4E8B\u4EF6",
      body: "\u89E6\u53D1\u6761\u4EF6\uFF1A\n\u6838\u5FC3\u73A9\u6CD5 / \u5267\u60C5\u8F6C\u6298\uFF1A\n\u5206\u652F\u8D70\u5411\uFF1A",
      category: "\u5267\u60C5",
      color: "#D97706",
      defaultVars: { exp: 500, tested: false },
      buttons: [
        {
          id: "btn-test",
          label: "\u6807\u8BB0\u5DF2\u767D\u76D2\u6D4B\u8BD5",
          variant: "primary",
          actionType: "script",
          code: `vars.tested = true;
vars.testedAt = lib.now();`
        }
      ]
    }
  },
  {
    id: "tpl-character",
    name: "\u89D2\u8272 / NPC \u6863\u6848",
    description: "\u542B\u57FA\u7840\u5C5E\u6027\u53D8\u91CF\u4E0E\u4E00\u952E\u6A21\u62DF\u5347\u7EA7\u8BA1\u7B97",
    group: "\u7B56\u5212\u4E0E\u4E16\u754C\u89C2",
    kind: "node",
    color: "#BE123C",
    nodePreset: {
      width: 280,
      height: 185,
      title: "\u89D2\u8272\u540D \xB7 \u9635\u8425",
      body: "\u6027\u683C\u6807\u7B7E\uFF1A\n\u6838\u5FC3\u52A8\u673A\uFF1A\n\u4E0E\u5176\u4ED6\u89D2\u8272\u5173\u7CFB\uFF1A",
      category: "\u89D2\u8272",
      color: "#BE123C",
      defaultVars: { lv: 1, hp: 100, atk: 18 },
      buttons: [
        {
          id: "btn-levelup",
          label: "\u6A21\u62DF\u5347\u7EA7 +1",
          variant: "primary",
          actionType: "script",
          code: `const lv = lib.inc('lv', 1);
vars.hp = 100 + (lv - 1) * 25;
vars.atk = 18 + (lv - 1) * 5;`
        }
      ]
    }
  },
  // 三、工程与运维
  {
    id: "tpl-api-service",
    name: "\u5FAE\u670D\u52A1 / API \u8282\u70B9",
    description: "\u5E26\u670D\u52A1\u7AEF\u4EE3\u7406\u63A2\u6D3B\u6309\u94AE\u4E0E\u54CD\u5E94\u72B6\u6001\u8BB0\u5F55",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#1D4ED8",
    nodePreset: {
      width: 300,
      height: 185,
      title: "API \u670D\u52A1\u8282\u70B9",
      body: "\u804C\u8D23\u8BF4\u660E\uFF1A\n\u4E0A\u6E38\u4F9D\u8D56 / \u4E0B\u6E38\u8C03\u7528\uFF1A\nSLA \u76EE\u6807\uFF1A99.9%",
      category: "SERVICE",
      color: "#1D4ED8",
      defaultVars: { env: "prod", healthy: true },
      buttons: [
        {
          id: "btn-ping",
          label: "\u4EE3\u7406\u63A2\u6D3B GET",
          variant: "primary",
          actionType: "proxy_http",
          proxyUrl: "https://httpbin.org/get?service=ping",
          proxyMethod: "GET"
        }
      ]
    }
  },
  {
    id: "tpl-metric-card",
    name: "\u76D1\u63A7\u6307\u6807\u5361",
    description: "\u6A21\u62DF\u8D1F\u8F7D\u91C7\u6837\u3001\u5EF6\u8FDF\u544A\u8B66\u9608\u503C\u6F14\u793A",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#B45309",
    nodePreset: {
      width: 270,
      height: 170,
      title: "\u96C6\u7FA4\u8D1F\u8F7D\u76D1\u63A7",
      body: "\u5173\u6CE8\u6307\u6807\uFF1AP99 \u5EF6\u8FDF\u3001\u9519\u8BEF\u7387\u4E0E CPU \u8D1F\u8F7D",
      category: "OPS",
      color: "#B45309",
      defaultVars: { cpu: 0.35, alert: "\u6B63\u5E38" },
      buttons: [
        {
          id: "btn-sample",
          label: "\u8D1F\u8F7D +0.15",
          variant: "danger",
          actionType: "script",
          code: `const c = Math.min(1, lib.inc('cpu', 0.15));
vars.cpu = c;
vars.alert = c >= 0.8 ? '\u544A\u8B66' : '\u6B63\u5E38';`
        }
      ]
    }
  },
  {
    id: "tpl-gateway",
    name: "\u6761\u4EF6\u5206\u652F / \u8DEF\u7531\u7F51\u5173",
    description: "\u7528\u4E8E\u67B6\u6784\u84DD\u56FE\u4E2D\u7684\u6D41\u91CF\u6216\u903B\u8F91\u5206\u6D41\u8BF4\u660E",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#0369A1",
    nodePreset: {
      width: 260,
      height: 165,
      title: "\u8DEF\u7531\u7F51\u5173\u8282\u70B9",
      body: "\u8DEF\u7531\u89C4\u5219\uFF1A\u6309\u533A\u57DF / \u7070\u5EA6\u6BD4\u4F8B\u5206\u53D1",
      category: "GATEWAY",
      color: "#0369A1",
      defaultVars: { canaryRatio: 10 },
      buttons: [
        {
          id: "btn-canary",
          label: "\u7070\u5EA6 +10%",
          variant: "secondary",
          actionType: "script",
          code: `vars.canaryRatio = ((Number(vars.canaryRatio) || 0) + 10) % 110;`
        }
      ]
    }
  },
  {
    id: "tpl-script-spawner",
    name: "\u8DE8\u63A7\u4EF6\u8054\u52A8\u63A7\u5236\u53F0\uFF08\u811A\u672C\uFF09",
    description: "\u5185\u7F6E\u8F93\u5165\u6846+\u56DE\u8F66\u53D1\u9001+\u52A8\u6001\u9020\u5B50\u63A7\u4EF6+emit\u6D88\u606F\u901A\u4FE1",
    group: "\u5DE5\u7A0B\u4E0E\u8FD0\u7EF4",
    kind: "node",
    color: "#2563EB",
    nodePreset: {
      width: 380,
      height: 210,
      title: "\u8054\u52A8\u63A7\u5236\u53F0",
      body: "",
      category: "\u8054\u52A8",
      color: "#2563EB",
      defaultVars: { draft: "", count: 0 },
      script: `vars.contents = [
  { type: 'text', text: '\u8F93\u5165\u6D88\u606F\u540E\u6309\u56DE\u8F66\u5E7F\u64AD\u7ED9\u5168\u753B\u5E03\u811A\u672C\u63A7\u4EF6', align: 'center', color: '#1E40AF', fontSize: 12, bold: true },
  [
    { type: 'input', id: 'bcInput', bind: 'draft', placeholder: '\u8F93\u5165\u5E7F\u64AD\u5185\u5BB9\uFF08\u56DE\u8F66\u53D1\u9001\uFF09...' },
    { type: 'button', id: 'bcSend', label: '\u5E7F\u64AD', width: 64, variant: 'primary' }
  ],
  { type: 'text', text: vars.status || '\u7B49\u5F85\u5E7F\u64AD\u2026', fontSize: 11, color: '#475569' }
];
async function doBroadcast(raw) {
  const txt = String(raw ?? vars.draft ?? '').trim();
  if (!txt) { vars.status = '\u5185\u5BB9\u4E0D\u80FD\u4E3A\u7A7A'; return; }
  await broadcast('ping', { text: txt });
  vars.draft = '';
  vars.count = (Number(vars.count) || 0) + 1;
  vars.status = '\u5DF2\u5E7F\u64AD #' + vars.count + '\uFF1A' + txt;
}
on('bcSend', async () => doBroadcast(vars.draft));
onSubmit('bcInput', async (v) => doBroadcast(v));`
    }
  },
  // 四、注释与基础
  {
    id: "tpl-blank-widget",
    name: "\u7A7A\u767D\u81EA\u7531\u63A7\u4EF6",
    description: "\u65E0\u9884\u8BBE\u6309\u94AE\u7684\u5E72\u51C0\u8282\u70B9\uFF0C\u968F\u65F6\u70B9\u51FB\u7F16\u8F91\u6269\u5C55",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "node",
    color: "#334155",
    nodePreset: {
      width: 260,
      height: 150,
      title: "\u65B0\u63A7\u4EF6",
      body: "\u53CC\u51FB\u6216\u70B9\u51FB\u6B64\u5904\u76F4\u63A5\u8F93\u5165\u6B63\u6587\u5185\u5BB9\u2026",
      category: "\u901A\u7528",
      color: "#334155",
      defaultVars: {},
      buttons: []
    }
  },
  {
    id: "tpl-ann-textbox",
    name: "\u80CC\u666F\u6587\u672C\u6846\uFF08\u8272\u5757\uFF09",
    description: "\u652F\u6301\u8BBE\u6587\u5B57\u989C\u8272\u4E0E\u8272\u5757\u5E95\u8272\uFF0C\u4E5F\u80FD\u88AB\u63A7\u4EF6\u811A\u672C\u52A8\u6001\u53D8\u8272",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "annotation",
    color: "#B45309",
    annotationPreset: {
      kind: "text",
      width: 360,
      height: 110,
      text: "\u8272\u5757\u6587\u672C\u6846\n\u652F\u6301\u591A\u884C\u81EA\u52A8\u6362\u884C\u4E0D\u62C9\u4F38\uFF0C\u5F00\u542F\u6CE8\u91CA\u7F16\u8F91\u53EF\u968F\u65F6\u8C03\u8272",
      fontSize: 16,
      color: "#78350F",
      bgColor: "#FEF3C7",
      bgOpacity: 0.9,
      weight: "bold",
      nonInteractive: true
    }
  },
  {
    id: "tpl-ann-header",
    name: "\u533A\u57DF\u5927\u6807\u9898\uFF08\u900F\u660E\u7A7F\u900F\uFF09",
    description: "30px \u7C97\u4F53\u5730\u56FE\u5206\u533A\u6807\u724C\uFF0C\u7F29\u8FDC\u5168\u666F\u4F9D\u7136\u6E05\u6670",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "annotation",
    color: "#0F766E",
    annotationPreset: {
      kind: "text",
      width: 480,
      height: 68,
      text: "\u65B0\u533A\u57DF\u5927\u6807\u9898 \xB7 \u62D6\u52A8\u5B9A\u4F4D",
      fontSize: 28,
      color: "#0F766E",
      bgColor: "transparent",
      bgOpacity: 0,
      weight: "bold",
      nonInteractive: true
    }
  },
  {
    id: "tpl-image-node",
    name: "\u56FE\u7247\u8282\u70B9",
    description: "\u7EAF\u5916\u94FE\u56FE\u7247\u8282\u70B9\uFF0C\u652F\u6301\u7B49\u6BD4/\u88C1\u5207\u5207\u6362\u3001Portal \u5927\u56FE\u706F\u7BB1\u9884\u89C8\u4E0E\u89C6\u53E3\u88C1\u526A",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "node",
    color: "#4F46E5",
    nodePreset: {
      title: "\u56FE\u7247\u753B\u677F",
      body: "",
      width: 360,
      height: 270,
      category: "\u56FE\u7247",
      color: "#4F46E5",
      defaultVars: {
        imageUrl: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 360 220'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23EEF2FF'/%3E%3Cstop offset='100%25' stop-color='%23E0E7FF'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='360' height='220' fill='url(%23g)'/%3E%3Ccircle cx='118' cy='86' r='30' fill='%234F46E5' fill-opacity='0.22'/%3E%3Cpath d='M52 174 L142 104 L212 152 L262 118 L314 174 Z' fill='%234F46E5' fill-opacity='0.3'/%3E%3Ctext x='180' y='198' text-anchor='middle' font-family='sans-serif' font-size='13' fill='%23312E81'%3E\u60AC\u505C\u53F3\u4E0A\u89D2\u53EF\u66F4\u6362\u56FE\u7247 \xB7 \u652F\u6301\u672C\u5730\u4E0A\u4F20\u4E0E\u5927\u56FE\u9884\u89C8%3C/text%3E%3C/svg%3E",
        imageFit: "contain",
        imageCaption: "\u793A\u4F8B\u56FE\u7247\uFF08\u60AC\u505C\u53F3\u4E0A\u89D2\u53EF\u6362\u56FE\u6216\u5168\u5C4F\u9884\u89C8\uFF09"
      },
      script: String.raw`vars.contents = [
  { type: 'image', id: 'imgMain', bindUrl: 'imageUrl', bindFit: 'imageFit', bindCaption: 'imageCaption' }
];`,
      inputPorts: [{ id: "in-1", label: "\u8F93\u5165" }],
      outputPorts: [{ id: "out-1", label: "\u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-video-node",
    name: "\u89C6\u9891\u8282\u70B9",
    description: "\u7EAF\u5916\u94FE MP4/WebM \u89C6\u9891\u8282\u70B9\uFF0C\u5E26\u500D\u901F/\u5FAA\u73AF/\u9759\u97F3\u4E0E\u79FB\u51FA\u89C6\u53E3\u81EA\u52A8\u6682\u505C",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "node",
    color: "#E11D48",
    nodePreset: {
      title: "\u89C6\u9891\u64AD\u653E\u5668",
      body: "",
      width: 420,
      height: 300,
      category: "\u89C6\u9891",
      color: "#E11D48",
      defaultVars: {
        videoUrl: "",
        videoLoop: false,
        videoMuted: false
      },
      script: String.raw`vars.contents = [
  { type: 'video', id: 'vidMain', bindUrl: 'videoUrl', bindLoop: 'videoLoop', bindMuted: 'videoMuted' }
];`,
      inputPorts: [{ id: "in-1", label: "\u8F93\u5165" }],
      outputPorts: [{ id: "out-1", label: "\u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-slider-node",
    name: "\u62D6\u52A8\u6761\u63A7\u4EF6",
    description: "\u5B9E\u65F6\u62D6\u52A8\u8C03\u8282\u6570\u503C\u5E76\u89E6\u53D1\u811A\u672C onChange\uFF0C\u53EF\u8FDE\u7EBF\u9A71\u52A8\u4E0B\u6E38\u8282\u70B9\u53C2\u6570",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#2563EB",
    nodePreset: {
      title: "\u53C2\u6570\u62D6\u52A8\u6761",
      body: "",
      width: 320,
      height: 200,
      category: "\u6ED1\u5757",
      color: "#2563EB",
      defaultVars: {
        value: 50,
        scale: 1
      },
      script: String.raw`const v = Number(vars.value ?? 50);
const s = Number(vars.scale ?? 1.0);
const result = Math.round(v * s * 10) / 10;

vars.contents = [
  { type: 'slider', id: 'sVal', bind: 'value', label: '主参数', min: 0, max: 100, step: 1, unit: '%', accentColor: '#2563EB' },
  { type: 'slider', id: 'sScale', bind: 'scale', label: '倍率系数', min: 0.5, max: 3, step: 0.1, unit: '×', accentColor: '#0D9488' },
  { type: 'text', text: '综合输出：' + result, align: 'center', color: '#1E293B', fontSize: 12, bold: true }
];

onChange(['value', 'scale'], () => {
  const nextVal = Number(vars.value ?? 50);
  const nextScale = Number(vars.scale ?? 1.0);
  vars.output = Math.round(nextVal * nextScale * 10) / 10;
});`,
      inputPorts: [],
      outputPorts: [{ id: "out-1", label: "\u6570\u503C\u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-pad2d-node",
    name: "2D Pad \u62D6\u52A8\u677F",
    description: "\u6DF1\u8272\u4E8C\u7EF4\u89E6\u63A7\u677F\uFF08\u5341\u5B57\u51C6\u661F + \u53D1\u5149\u62D6\u62FD\u7403 + \u53CC\u51FB\u5F52\u4E2D\uFF09\uFF0C\u53EF\u5B9E\u65F6\u8F93\u51FA X/Y \u5750\u6807\u8054\u52A8\u4E0B\u6E38",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#D97706",
    nodePreset: {
      title: "2D Pad \u63A7\u5236\u5668",
      body: "",
      width: 310,
      height: 310,
      category: "2D Pad",
      color: "#D97706",
      defaultVars: {
        padX: 0,
        padY: 0
      },
      script: String.raw`const x = Number(vars.padX ?? 0);
const y = Number(vars.padY ?? 0);

vars.contents = [
  {
    type: 'pad2d',
    id: 'xyPad',
    label: '二维坐标触控板',
    labelX: 'X',
    labelY: 'Y',
    bindX: 'padX',
    bindY: 'padY',
    minX: -100,
    maxX: 100,
    stepX: 1,
    minY: -100,
    maxY: 100,
    stepY: 1,
    height: 176,
    accentColor: '#F59E0B'
  },
  {
    type: 'text',
    text: '当前向量：(' + x + ', ' + y + ')',
    align: 'center',
    color: '#334155',
    fontSize: 12,
    bold: true
  }
];

onChange(['padX', 'padY'], () => {
  const vx = Number(vars.padX ?? 0);
  const vy = Number(vars.padY ?? 0);
  vars.magnitude = Math.round(Math.hypot(vx, vy) * 10) / 10;
});`,
      inputPorts: [],
      outputPorts: [{ id: "out-1", label: "XY \u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-image-button-node",
    name: "\u56FE\u7247\u6309\u94AE (4\u6001)",
    description: "\u7528\u56FE\u7247\u66FF\u4EE3\u6309\u94AE\uFF0C\u652F\u6301 on / off / hover / click \u56DB\u79CD\u72B6\u6001\u8D34\u56FE\u4E0E\u60AC\u505C\u5FEB\u6377\u6362\u56FE",
    group: "\u77E5\u8BC6\u5730\u56FE",
    kind: "node",
    color: "#059669",
    nodePreset: {
      title: "\u56DB\u6001\u56FE\u7247\u6309\u94AE",
      body: "",
      width: 300,
      height: 215,
      category: "\u56FE\u94AE",
      color: "#059669",
      defaultVars: {
        powerOn: false,
        clicks: 0,
        btnOffImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%23334155' stroke='%2364748B' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%2394A3B8'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23E2E8F0'%3EOFF \xB7 \u5F85\u673A%3C/text%3E%3C/svg%3E",
        btnOnImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%23059669' stroke='%2334D399' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%23A7F3D0'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3EON \xB7 \u5DF2\u5F00\u542F%3C/text%3E%3C/svg%3E",
        btnHoverImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='4' y='6' width='232' height='76' rx='18' fill='%234F46E5' stroke='%23A5B4FC' stroke-width='3'/%3E%3Ccircle cx='46' cy='44' r='12' fill='%23E0E7FF'/%3E%3Ctext x='136' y='50' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3EHOVER \xB7 \u60AC\u505C%3C/text%3E%3C/svg%3E",
        btnClickImage: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 88'%3E%3Crect x='6' y='10' width='228' height='70' rx='16' fill='%23D97706' stroke='%23FDE68A' stroke-width='3'/%3E%3Ccircle cx='46' cy='45' r='12' fill='%23FEF3C7'/%3E%3Ctext x='136' y='51' text-anchor='middle' font-family='sans-serif' font-size='18' font-weight='700' fill='%23FFFFFF'%3ECLICK \xB7 \u6309\u4E0B%3C/text%3E%3C/svg%3E"
      },
      script: String.raw`const isOn = Boolean(vars.powerOn);
const clicks = Number(vars.clicks ?? 0);

vars.contents = [
  {
    type: 'image_button',
    id: 'imgToggleBtn',
    bind: 'powerOn',
    label: isOn ? '已开启' : '未开启',
    toggle: true,
    bindOffImage: 'btnOffImage',
    bindOnImage: 'btnOnImage',
    bindHoverImage: 'btnHoverImage',
    bindClickImage: 'btnClickImage',
    height: 92,
    showStateBadge: true
  },
  {
    type: 'text',
    text: '状态：' + (isOn ? 'ON' : 'OFF') + ' · 累计点击 ' + clicks + ' 次',
    align: 'center',
    color: isOn ? '#047857' : '#475569',
    fontSize: 12,
    bold: true
  }
];

on('imgToggleBtn', () => {
  vars.clicks = Number(vars.clicks ?? 0) + 1;
});`,
      inputPorts: [{ id: "in-1", label: "\u8F93\u5165" }],
      outputPorts: [{ id: "out-1", label: "\u72B6\u6001\u8F93\u51FA" }]
    }
  },
  {
    id: "tpl-ann-image",
    name: "\u80CC\u666F\u63D2\u56FE\uFF08\u7B49\u6BD4\u4E0D\u62C9\u4F38\uFF09",
    description: "\u6240\u89C1\u5373\u6240\u5F97\u63D2\u56FE\u7EC4\u4EF6\uFF0C\u652F\u6301\u6362\u672C\u5730\u56FE\u4E0E\u8BBE\u80CC\u666F\u8272\u5757",
    group: "\u6CE8\u91CA\u4E0E\u57FA\u7840",
    kind: "annotation",
    color: "#2563EB",
    annotationPreset: {
      kind: "image",
      width: 320,
      height: 200,
      text: "\u793A\u4F8B\u80CC\u666F\u63D2\u56FE",
      fontSize: 14,
      color: "#1E293B",
      bgColor: "#FFFFFF",
      bgOpacity: 0.9,
      imageUrl: "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 200'%3E%3Crect width='320' height='200' rx='14' fill='%23EFF6FF'/%3E%3Ccircle cx='90' cy='78' r='28' fill='%232563EB' fill-opacity='0.2' stroke='%232563EB' stroke-width='3'/%3E%3Crect x='170' y='52' width='104' height='52' rx='8' fill='%230F766E' fill-opacity='0.18' stroke='%230F766E' stroke-width='3'/%3E%3Cpath d='M118 78 L168 78' stroke='%23475569' stroke-width='3' stroke-dasharray='6 4'/%3E%3Ctext x='160' y='156' text-anchor='middle' font-family='sans-serif' font-size='16' font-weight='700' fill='%231E293B'%3E\u793A\u4F8B\u80CC\u666F\u63D2\u56FE\uFF08\u7B49\u6BD4\u7F29\u653E\u4E0D\u62C9\u4F38\uFF09%3C/text%3E%3C/svg%3E",
      weight: "normal",
      nonInteractive: true
    }
  }
];

// src/core/agentOps.ts
var MAX_OPS_PER_BATCH = 50;
function validateLeafBlockSafety(block) {
  if (!block || typeof block !== "object") return "blocks \u4E2D\u5305\u542B\u975E\u6CD5\u5143\u7D20";
  const b = block;
  switch (b.type) {
    case "image":
      if (typeof b.url === "string" && b.url.trim() && !isSafeImageUrl(b.url)) {
        return `image \u79EF\u6728\u5305\u542B\u4E0D\u5B89\u5168\u7684 url\uFF1A${b.url}`;
      }
      break;
    case "video":
      if (typeof b.url === "string" && b.url.trim() && !isSafeVideoUrl(b.url)) {
        return `video \u79EF\u6728\u5305\u542B\u4E0D\u5B89\u5168\u7684 url\uFF1A${b.url}`;
      }
      if (typeof b.poster === "string" && b.poster.trim() && !isSafeImageUrl(b.poster)) {
        return `video \u79EF\u6728\u5305\u542B\u4E0D\u5B89\u5168\u7684 poster\uFF1A${b.poster}`;
      }
      break;
    case "pdf":
      if (typeof b.url === "string" && b.url.trim() && !isSafePdfUrl(b.url)) {
        return `pdf \u79EF\u6728\u5305\u542B\u4E0D\u5B89\u5168\u7684 url\uFF1A${b.url}`;
      }
      break;
    case "api_poller":
      if (typeof b.url === "string" && b.url.trim() && !isSafePollUrl(b.url)) {
        return `api_poller \u79EF\u6728\u5305\u542B\u4E0D\u5B89\u5168\u7684 url\uFF1A${b.url}`;
      }
      break;
    case "image_button":
      for (const field of ["offImage", "onImage", "hoverImage", "clickImage"]) {
        const v = b[field];
        if (typeof v === "string" && v.trim() && !isSafeImageUrl(v)) {
          return `image_button \u79EF\u6728\u5305\u542B\u4E0D\u5B89\u5168\u7684 ${field}\uFF1A${v}`;
        }
      }
      break;
    default:
      break;
  }
  return null;
}
function validateBlocksSafety(blocks) {
  for (const item of blocks) {
    if (Array.isArray(item)) {
      for (const sub of item) {
        const err = validateLeafBlockSafety(sub);
        if (err) return err;
      }
    } else {
      const err = validateLeafBlockSafety(item);
      if (err) return err;
    }
  }
  return null;
}
function validateButtonsSafety(buttons) {
  for (const rawBtn of buttons) {
    if (!rawBtn || typeof rawBtn !== "object") continue;
    const btn = rawBtn;
    if (btn.actionType === "script" && typeof btn.code === "string" && btn.code.trim()) {
      const check = validateScriptSafety(btn.code);
      if (!check.ok) {
        return `\u6309\u94AE\u811A\u672C\u5B89\u5168\u6821\u9A8C\u672A\u901A\u8FC7\uFF1A${check.reason}`;
      }
    }
  }
  return null;
}
function clampDim(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
function sanitizeId(raw, prefix, existing) {
  const cleaned = typeof raw === "string" ? raw.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : "";
  if (cleaned && !(cleaned in existing)) return cleaned;
  let seq = 1;
  while (true) {
    const candidate = `${prefix}-${Date.now().toString(36)}-${seq}`;
    if (!(candidate in existing)) return candidate;
    seq += 1;
  }
}
function normalizeAgentBlueprint(raw) {
  if (raw && typeof raw === "object") {
    const bp = raw;
    return {
      version: typeof bp.version === "number" && Number.isFinite(bp.version) ? bp.version : 1,
      chunkSize: typeof bp.chunkSize === "number" && Number.isFinite(bp.chunkSize) ? bp.chunkSize : 512,
      nodes: bp.nodes && typeof bp.nodes === "object" ? JSON.parse(JSON.stringify(bp.nodes)) : {},
      annotations: bp.annotations && typeof bp.annotations === "object" ? JSON.parse(JSON.stringify(bp.annotations)) : {},
      edges: bp.edges && typeof bp.edges === "object" ? JSON.parse(JSON.stringify(bp.edges)) : {}
    };
  }
  return { version: 1, chunkSize: 512, nodes: {}, annotations: {}, edges: {} };
}
function collectBoxes(bp) {
  const boxes = [];
  for (const n of Object.values(bp.nodes)) {
    boxes.push({ x: n.x, y: n.y, width: n.width, height: n.height });
  }
  return boxes;
}
function summarizeBlueprintForAgent(raw) {
  const bp = normalizeAgentBlueprint(raw);
  const nodes = Object.values(bp.nodes).map((n) => ({
    id: n.id,
    title: n.title,
    category: n.category,
    x: n.x,
    y: n.y,
    width: n.width,
    height: n.height,
    color: n.color,
    rev: n.rev,
    hasScript: Boolean(n.script && n.script.trim()),
    varKeys: Object.keys(n.defaultVars || {})
  }));
  const annotations = Object.values(bp.annotations).map((a) => ({
    id: a.id,
    kind: a.kind,
    text: a.text,
    imageUrl: a.imageUrl,
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
    bgColor: a.bgColor
  }));
  const edges = Object.values(bp.edges).map((e) => {
    const cleanCps = sanitizeControlPoints(e.controlPoints);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      bidirectional: e.bidirectional,
      ...cleanCps.length > 0 ? { controlPoints: cleanCps } : {}
    };
  });
  return {
    version: bp.version,
    nodeCount: nodes.length,
    annotationCount: annotations.length,
    edgeCount: edges.length,
    nodes,
    annotations,
    edges
  };
}
function listAgentTemplates() {
  return BUILTIN_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    group: t.group,
    kind: t.kind,
    description: t.description
  }));
}
function applyAgentOperations(base, ops, opts) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, error: "ops \u5FC5\u987B\u662F\u975E\u7A7A\u6570\u7EC4", failedIndex: 0 };
  }
  const maxOps = Math.max(1, Math.min(200, opts?.maxOps ?? MAX_OPS_PER_BATCH));
  if (ops.length > maxOps) {
    return { ok: false, error: `\u5355\u6B21\u6279\u91CF\u64CD\u4F5C\u4E0D\u80FD\u8D85\u8FC7 ${maxOps} \u6761`, failedIndex: maxOps };
  }
  const actor = (opts?.actor || "agent").trim().slice(0, 48) || "agent";
  const next = normalizeAgentBlueprint(base);
  const results = [];
  for (let i = 0; i < ops.length; i++) {
    const rawOp = ops[i];
    if (!rawOp || typeof rawOp !== "object" || typeof rawOp.op !== "string") {
      return { ok: false, error: `\u7B2C ${i} \u6761\u64CD\u4F5C\u7F3A\u5C11\u5408\u6CD5\u7684 op \u5B57\u6BB5`, failedIndex: i };
    }
    const item = rawOp;
    switch (item.op) {
      case "create_from_template": {
        const tpl = BUILTIN_TEMPLATES.find((t) => t.id === item.templateId);
        if (!tpl) {
          return {
            ok: false,
            error: `\u672A\u627E\u5230\u5185\u7F6E\u6A21\u677F\uFF1A${String(item.templateId || "")}`,
            failedIndex: i
          };
        }
        if (tpl.kind === "node" && tpl.nodePreset) {
          const preset = JSON.parse(JSON.stringify(tpl.nodePreset));
          if (preset.script && preset.script.trim()) {
            const check = validateScriptSafety(preset.script);
            if (!check.ok) {
              return { ok: false, error: `\u6A21\u677F\u811A\u672C\u5B89\u5168\u6821\u9A8C\u672A\u901A\u8FC7\uFF1A${check.reason}`, failedIndex: i };
            }
          }
          const width = clampDim(item.width, preset.width || 320, 140, 1600);
          const height = clampDim(item.height, preset.height || 220, 80, 1400);
          let x = Number(item.x);
          let y = Number(item.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            const placed = findNonOverlappingPosition({ x: 120, y: 120, width, height }, collectBoxes(next));
            x = placed.x;
            y = placed.y;
          }
          const id = sanitizeId(item.id, tpl.id, next.nodes);
          const mergedVars = {
            ...preset.defaultVars || {},
            ...item.defaultVars && typeof item.defaultVars === "object" ? JSON.parse(JSON.stringify(item.defaultVars)) : {}
          };
          if (Array.isArray(mergedVars.contents)) {
            const contentsErr = validateBlocksSafety(mergedVars.contents);
            if (contentsErr) return { ok: false, error: contentsErr, failedIndex: i };
          }
          const node = {
            ...preset,
            id,
            x: Math.round(x),
            y: Math.round(y),
            width,
            height,
            title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : preset.title,
            body: typeof item.body === "string" ? item.body : preset.body,
            color: typeof item.color === "string" && item.color.trim() ? item.color.trim() : preset.color,
            defaultVars: mergedVars,
            rev: 1,
            cid: actor
          };
          next.nodes[id] = node;
          results.push({ index: i, op: item.op, id, bounds: { x: node.x, y: node.y, width: node.width, height: node.height } });
        } else if (tpl.kind === "annotation" && tpl.annotationPreset) {
          const preset = JSON.parse(JSON.stringify(tpl.annotationPreset));
          const finalImageUrl = item.imageUrl !== void 0 ? item.imageUrl : preset.imageUrl;
          if (preset.kind === "image" && finalImageUrl && !isSafeImageUrl(finalImageUrl)) {
            return { ok: false, error: "create_from_template(annotation/image) \u63D0\u4F9B\u7684 imageUrl \u4E0D\u5B89\u5168", failedIndex: i };
          }
          const width = clampDim(item.width, preset.width || 420, 80, 3200);
          const height = clampDim(item.height, preset.height || 140, 40, 2400);
          let x = Number(item.x);
          let y = Number(item.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            const placed = findNonOverlappingPosition({ x: 80, y: 80, width, height }, collectBoxes(next));
            x = placed.x;
            y = placed.y;
          }
          const id = sanitizeId(item.id, tpl.id, next.annotations);
          const ann = {
            ...preset,
            id,
            x: Math.round(x),
            y: Math.round(y),
            width,
            height,
            text: typeof item.text === "string" ? item.text : preset.text,
            color: typeof item.color === "string" && item.color.trim() ? item.color.trim() : preset.color,
            bgColor: typeof item.bgColor === "string" && item.bgColor.trim() ? item.bgColor.trim() : preset.bgColor,
            bgOpacity: typeof item.bgOpacity === "number" && Number.isFinite(item.bgOpacity) ? Math.max(0, Math.min(1, item.bgOpacity)) : preset.bgOpacity,
            imageUrl: finalImageUrl,
            rev: 1,
            cid: actor
          };
          next.annotations[id] = ann;
          results.push({ index: i, op: item.op, id, bounds: { x: ann.x, y: ann.y, width: ann.width, height: ann.height } });
        } else {
          return { ok: false, error: `\u6A21\u677F ${tpl.id} \u7F3A\u5C11\u9884\u8BBE\u914D\u7F6E`, failedIndex: i };
        }
        break;
      }
      case "create_widget": {
        if (typeof item.title !== "string" || !item.title.trim()) {
          return { ok: false, error: "create_widget \u9700\u8981\u975E\u7A7A title", failedIndex: i };
        }
        if (typeof item.script === "string" && item.script.trim()) {
          const check = validateScriptSafety(item.script);
          if (!check.ok) {
            return { ok: false, error: `\u811A\u672C\u5B89\u5168\u6821\u9A8C\u672A\u901A\u8FC7\uFF1A${check.reason}`, failedIndex: i };
          }
        }
        const width = clampDim(item.width, 320, 140, 1600);
        const height = clampDim(item.height, 220, 80, 1400);
        let x = Number(item.x);
        let y = Number(item.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const placed = findNonOverlappingPosition({ x: 120, y: 120, width, height }, collectBoxes(next));
          x = placed.x;
          y = placed.y;
        }
        const id = sanitizeId(item.id, "agent-node", next.nodes);
        const defaultVars = item.defaultVars && typeof item.defaultVars === "object" ? JSON.parse(JSON.stringify(item.defaultVars)) : {};
        if (Array.isArray(defaultVars.contents)) {
          const contentsErr = validateBlocksSafety(defaultVars.contents);
          if (contentsErr) return { ok: false, error: contentsErr, failedIndex: i };
        }
        if (Array.isArray(item.blocks)) {
          const blockErr = validateBlocksSafety(item.blocks);
          if (blockErr) return { ok: false, error: blockErr, failedIndex: i };
          defaultVars.contents = JSON.parse(JSON.stringify(item.blocks));
        }
        if (Array.isArray(item.buttons)) {
          const btnErr = validateButtonsSafety(item.buttons);
          if (btnErr) return { ok: false, error: btnErr, failedIndex: i };
        }
        const node = {
          id,
          x: Math.round(x),
          y: Math.round(y),
          width,
          height,
          title: item.title.trim().slice(0, 120),
          body: typeof item.body === "string" ? item.body : "",
          category: typeof item.category === "string" ? item.category.trim().slice(0, 40) : "Agent",
          color: typeof item.color === "string" && item.color.trim() ? item.color.trim() : "#2563EB",
          script: typeof item.script === "string" ? item.script : void 0,
          locked: Boolean(item.locked),
          defaultVars,
          buttons: Array.isArray(item.buttons) ? item.buttons : void 0,
          inputPorts: Array.isArray(item.inputPorts) ? item.inputPorts : void 0,
          outputPorts: Array.isArray(item.outputPorts) ? item.outputPorts : void 0,
          rev: 1,
          cid: actor
        };
        next.nodes[id] = node;
        results.push({ index: i, op: item.op, id, bounds: { x: node.x, y: node.y, width: node.width, height: node.height } });
        break;
      }
      case "update_widget": {
        const target = typeof item.id === "string" ? next.nodes[item.id] : void 0;
        if (!target) {
          return { ok: false, error: `\u672A\u627E\u5230\u63A7\u4EF6\u8282\u70B9\uFF1A${String(item.id || "")}`, failedIndex: i };
        }
        if (typeof item.script === "string" && item.script.trim()) {
          const check = validateScriptSafety(item.script);
          if (!check.ok) {
            return { ok: false, error: `\u811A\u672C\u5B89\u5168\u6821\u9A8C\u672A\u901A\u8FC7\uFF1A${check.reason}`, failedIndex: i };
          }
        }
        const nextVars = item.defaultVars && typeof item.defaultVars === "object" ? item.mergeVars === false ? JSON.parse(JSON.stringify(item.defaultVars)) : { ...target.defaultVars || {}, ...JSON.parse(JSON.stringify(item.defaultVars)) } : { ...target.defaultVars || {} };
        if (Array.isArray(nextVars.contents)) {
          const contentsErr = validateBlocksSafety(nextVars.contents);
          if (contentsErr) return { ok: false, error: contentsErr, failedIndex: i };
        }
        if (Array.isArray(item.blocks)) {
          const blockErr = validateBlocksSafety(item.blocks);
          if (blockErr) return { ok: false, error: blockErr, failedIndex: i };
          nextVars.contents = JSON.parse(JSON.stringify(item.blocks));
        }
        if (Array.isArray(item.buttons)) {
          const btnErr = validateButtonsSafety(item.buttons);
          if (btnErr) return { ok: false, error: btnErr, failedIndex: i };
        }
        const updated = {
          ...target,
          title: typeof item.title === "string" && item.title.trim() ? item.title.trim().slice(0, 120) : target.title,
          body: typeof item.body === "string" ? item.body : target.body,
          category: typeof item.category === "string" ? item.category.trim().slice(0, 40) : target.category,
          color: typeof item.color === "string" && item.color.trim() ? item.color.trim() : target.color,
          x: Number.isFinite(Number(item.x)) ? Math.round(Number(item.x)) : target.x,
          y: Number.isFinite(Number(item.y)) ? Math.round(Number(item.y)) : target.y,
          width: item.width !== void 0 ? clampDim(item.width, target.width, 140, 1600) : target.width,
          height: item.height !== void 0 ? clampDim(item.height, target.height, 80, 1400) : target.height,
          script: item.script !== void 0 ? item.script : target.script,
          locked: item.locked !== void 0 ? Boolean(item.locked) : target.locked,
          defaultVars: nextVars,
          buttons: Array.isArray(item.buttons) ? item.buttons : target.buttons,
          inputPorts: Array.isArray(item.inputPorts) ? item.inputPorts : target.inputPorts,
          outputPorts: Array.isArray(item.outputPorts) ? item.outputPorts : target.outputPorts,
          rev: (target.rev || 0) + 1,
          cid: actor
        };
        next.nodes[target.id] = updated;
        results.push({ index: i, op: item.op, id: target.id, bounds: { x: updated.x, y: updated.y, width: updated.width, height: updated.height } });
        break;
      }
      case "delete_widget": {
        if (typeof item.id !== "string" || !next.nodes[item.id]) {
          return { ok: false, error: `\u672A\u627E\u5230\u5F85\u5220\u9664\u63A7\u4EF6\u8282\u70B9\uFF1A${String(item.id || "")}`, failedIndex: i };
        }
        delete next.nodes[item.id];
        for (const [eid, edge] of Object.entries(next.edges)) {
          if (edge.source === item.id || edge.target === item.id) {
            delete next.edges[eid];
          }
        }
        results.push({ index: i, op: item.op, id: item.id });
        break;
      }
      case "create_annotation": {
        const kind = item.kind === "image" ? "image" : "text";
        if (kind === "image") {
          if (typeof item.imageUrl !== "string" || !isSafeImageUrl(item.imageUrl)) {
            return { ok: false, error: "create_annotation(image) \u9700\u8981\u5408\u6CD5\u5B89\u5168\u7684 imageUrl", failedIndex: i };
          }
        }
        const width = clampDim(item.width, kind === "image" ? 480 : 420, 80, 3200);
        const height = clampDim(item.height, kind === "image" ? 320 : 120, 40, 2400);
        let x = Number(item.x);
        let y = Number(item.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          const placed = findNonOverlappingPosition({ x: 80, y: 80, width, height }, collectBoxes(next));
          x = placed.x;
          y = placed.y;
        }
        const id = sanitizeId(item.id, "agent-ann", next.annotations);
        const ann = {
          id,
          kind,
          x: Math.round(x),
          y: Math.round(y),
          width,
          height,
          text: typeof item.text === "string" ? item.text : "",
          fontSize: clampDim(item.fontSize, 20, 12, 96),
          color: typeof item.color === "string" && item.color.trim() ? item.color.trim() : "#1E293B",
          bgColor: typeof item.bgColor === "string" && item.bgColor.trim() ? item.bgColor.trim() : "#EFF6FF",
          bgOpacity: typeof item.bgOpacity === "number" && Number.isFinite(item.bgOpacity) ? Math.max(0, Math.min(1, item.bgOpacity)) : 0.45,
          imageUrl: kind === "image" ? item.imageUrl : void 0,
          weight: item.weight === "bold" ? "bold" : "normal",
          nonInteractive: item.nonInteractive !== false,
          rev: 1,
          cid: actor
        };
        next.annotations[id] = ann;
        results.push({ index: i, op: item.op, id, bounds: { x: ann.x, y: ann.y, width: ann.width, height: ann.height } });
        break;
      }
      case "update_annotation": {
        const target = typeof item.id === "string" ? next.annotations[item.id] : void 0;
        if (!target) {
          return { ok: false, error: `\u672A\u627E\u5230\u80CC\u666F\u6CE8\u91CA\u5C42\uFF1A${String(item.id || "")}`, failedIndex: i };
        }
        if (item.imageUrl !== void 0 && item.imageUrl !== "" && !isSafeImageUrl(item.imageUrl)) {
          return { ok: false, error: "update_annotation \u63D0\u4F9B\u7684 imageUrl \u4E0D\u5B89\u5168", failedIndex: i };
        }
        const updatedAnn = {
          ...target,
          text: typeof item.text === "string" ? item.text : target.text,
          imageUrl: item.imageUrl !== void 0 ? item.imageUrl : target.imageUrl,
          x: Number.isFinite(Number(item.x)) ? Math.round(Number(item.x)) : target.x,
          y: Number.isFinite(Number(item.y)) ? Math.round(Number(item.y)) : target.y,
          width: item.width !== void 0 ? clampDim(item.width, target.width, 80, 3200) : target.width,
          height: item.height !== void 0 ? clampDim(item.height, target.height, 40, 2400) : target.height,
          fontSize: item.fontSize !== void 0 ? clampDim(item.fontSize, target.fontSize, 12, 96) : target.fontSize,
          color: typeof item.color === "string" && item.color.trim() ? item.color.trim() : target.color,
          bgColor: typeof item.bgColor === "string" && item.bgColor.trim() ? item.bgColor.trim() : target.bgColor,
          bgOpacity: typeof item.bgOpacity === "number" && Number.isFinite(item.bgOpacity) ? Math.max(0, Math.min(1, item.bgOpacity)) : target.bgOpacity,
          weight: item.weight !== void 0 ? item.weight === "bold" ? "bold" : "normal" : target.weight,
          nonInteractive: item.nonInteractive !== void 0 ? Boolean(item.nonInteractive) : target.nonInteractive,
          rev: (target.rev || 0) + 1,
          cid: actor
        };
        next.annotations[target.id] = updatedAnn;
        results.push({ index: i, op: item.op, id: target.id, bounds: { x: updatedAnn.x, y: updatedAnn.y, width: updatedAnn.width, height: updatedAnn.height } });
        break;
      }
      case "delete_annotation": {
        if (typeof item.id !== "string" || !next.annotations[item.id]) {
          return { ok: false, error: `\u672A\u627E\u5230\u5F85\u5220\u9664\u80CC\u666F\u6CE8\u91CA\u5C42\uFF1A${String(item.id || "")}`, failedIndex: i };
        }
        delete next.annotations[item.id];
        results.push({ index: i, op: item.op, id: item.id });
        break;
      }
      case "connect_edge": {
        if (!item.source || !next.nodes[item.source]) {
          return { ok: false, error: `\u8FDE\u7EBF\u8D77\u70B9\u8282\u70B9\u4E0D\u5B58\u5728\uFF1A${String(item.source || "")}`, failedIndex: i };
        }
        if (!item.target || !next.nodes[item.target]) {
          return { ok: false, error: `\u8FDE\u7EBF\u7EC8\u70B9\u8282\u70B9\u4E0D\u5B58\u5728\uFF1A${String(item.target || "")}`, failedIndex: i };
        }
        const id = sanitizeId(item.id, "agent-edge", next.edges);
        const edge = {
          id,
          source: item.source,
          target: item.target,
          sourceHandle: typeof item.sourceHandle === "string" ? item.sourceHandle : void 0,
          targetHandle: typeof item.targetHandle === "string" ? item.targetHandle : void 0,
          label: typeof item.label === "string" ? item.label.slice(0, 60) : void 0,
          color: typeof item.color === "string" && item.color.trim() ? item.color.trim() : void 0,
          dashed: Boolean(item.dashed),
          bidirectional: Boolean(item.bidirectional),
          controlPoints: (() => {
            const cps = item.controlPoints ? sanitizeControlPoints(item.controlPoints) : [];
            return cps.length > 0 ? cps : void 0;
          })(),
          rev: 1,
          cid: actor
        };
        next.edges[id] = edge;
        results.push({ index: i, op: item.op, id });
        break;
      }
      case "delete_edge": {
        if (typeof item.id !== "string" || !next.edges[item.id]) {
          return { ok: false, error: `\u672A\u627E\u5230\u5F85\u5220\u9664\u8FDE\u7EBF\uFF1A${String(item.id || "")}`, failedIndex: i };
        }
        delete next.edges[item.id];
        results.push({ index: i, op: item.op, id: item.id });
        break;
      }
      default:
        return {
          ok: false,
          error: `\u4E0D\u652F\u6301\u7684\u64CD\u4F5C\u7C7B\u578B\uFF1A${String(item.op)}`,
          failedIndex: i
        };
    }
  }
  next.version = (next.version || 0) + 1;
  const counts = results.reduce((acc, r) => {
    acc[r.op] = (acc[r.op] || 0) + 1;
    return acc;
  }, {});
  const summary = `Agent(${actor}) \u6267\u884C ${results.length} \u9879\u64CD\u4F5C\uFF1A` + Object.entries(counts).map(([k, v]) => `${k}\xD7${v}`).join(", ");
  return { ok: true, blueprint: next, results, summary };
}
function getAgentToolSchema() {
  return [
    {
      name: "atlas_inspect_room",
      description: "\u8BFB\u53D6 Atlas Hybrid Canvas \u6307\u5B9A\u623F\u95F4\u7684\u5B9E\u65F6 revision\u3001\u5168\u90E8\u63A7\u4EF6/\u80CC\u666F/\u8FDE\u7EBF\u6458\u8981\u4EE5\u53CA\u53EF\u7528\u6A21\u677F\u6E05\u5355\uFF08\u5148\u540C\u6B65 WS \u5185\u5B58\u6001\uFF0C\u907F\u514D\u8BFB\u5230\u9648\u65E7\u5FEB\u7167\uFF09\u3002",
      parameters: {
        type: "object",
        properties: {
          room: { type: "string", description: '\u623F\u95F4\u8DEF\u5F84\uFF0C\u5982 "team/design"\uFF0C\u9ED8\u8BA4 "atlas-main"' },
          full: { type: "boolean", description: "\u4E3A true \u65F6\u540C\u65F6\u8FD4\u56DE\u5B8C\u6574 blueprint JSON" }
        }
      }
    },
    {
      name: "atlas_canvas_ops",
      description: "\u5728 Atlas Hybrid Canvas \u6307\u5B9A\u623F\u95F4\u5185\u539F\u5B50\u6279\u91CF\u521B\u5EFA\u3001\u4FEE\u6539\u6216\u5220\u9664\u63A7\u4EF6\uFF08\u652F\u6301\u5185\u7F6E\u6A21\u677F\u4E0E\u7ED3\u6784\u5316\u79EF\u6728\uFF09\u3001\u80CC\u666F\u6CE8\u91CA/\u63D2\u56FE\u4E0E\u8FDE\u7EBF\uFF0C\u652F\u6301 expectedRevision \u4E50\u89C2\u9501\u4E0E dryRun \u9884\u6F14\u3002",
      parameters: {
        type: "object",
        required: ["ops"],
        properties: {
          room: { type: "string", description: '\u623F\u95F4\u8DEF\u5F84\uFF0C\u5982 "team/design"' },
          actor: { type: "string", description: "Agent \u6807\u8BC6\uFF0C\u5199\u5165\u4FEE\u6539\u65E5\u5FD7\u4FBF\u4E8E\u5BA1\u8BA1\u4E0E\u56DE\u6863" },
          summary: { type: "string", description: "\u53EF\u9009\u7684\u4EBA\u7C7B\u53EF\u8BFB\u53D8\u66F4\u6458\u8981" },
          expectedRevision: {
            type: "number",
            description: "\u53EF\u9009\u4E50\u89C2\u9501\uFF1A\u82E5\u623F\u95F4\u5F53\u524D revision \u4E0E\u6B64\u503C\u4E0D\u7B26\u5219\u8FD4\u56DE 409 Conflict"
          },
          dryRun: {
            type: "boolean",
            description: "\u4E3A true \u65F6\u4EC5\u6821\u9A8C\u5E76\u8BA1\u7B97\u81EA\u52A8\u5E03\u5C40\u5750\u6807\uFF0C\u4E0D\u843D\u76D8\u3001\u4E0D\u5E7F\u64AD"
          },
          ops: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["op"],
              properties: {
                op: {
                  type: "string",
                  enum: [
                    "create_from_template",
                    "create_widget",
                    "update_widget",
                    "delete_widget",
                    "create_annotation",
                    "update_annotation",
                    "delete_annotation",
                    "connect_edge",
                    "delete_edge"
                  ]
                },
                templateId: { type: "string" },
                id: { type: "string" },
                title: { type: "string" },
                body: { type: "string" },
                kind: { type: "string", enum: ["text", "image"] },
                text: { type: "string" },
                imageUrl: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                width: { type: "number" },
                height: { type: "number" },
                color: { type: "string" },
                bgColor: { type: "string" },
                bgOpacity: { type: "number" },
                script: { type: "string" },
                blocks: { type: "array" },
                defaultVars: { type: "object" },
                mergeVars: { type: "boolean" },
                source: { type: "string" },
                target: { type: "string" },
                bidirectional: { type: "boolean" },
                controlPoints: {
                  type: "array",
                  description: "\u53EF\u9009\u8FDE\u7EBF\u63A7\u5236\u70B9\u6570\u7EC4 [{x, y}]\uFF0C\u6309\u987A\u5E8F\u5E73\u6ED1\u7ED5\u8FC7\u5361\u7247\uFF08\u6700\u591A 12 \u4E2A\uFF09",
                  items: {
                    type: "object",
                    required: ["x", "y"],
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  ];
}

// src/core/apiCore.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function toBytes(text) {
  return encoder.encode(text);
}
function fromBytes(bytes) {
  return decoder.decode(bytes);
}
function jsonResult(body, status = 200, extraHeaders) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders ?? {} },
    body: toBytes(JSON.stringify(body))
  };
}
function parseJsonBody(req) {
  if (req.body.length === 0) return null;
  try {
    return JSON.parse(fromBytes(req.body));
  } catch {
    return null;
  }
}
function header(req, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return "";
}
var ALLOWED_METHODS = /* @__PURE__ */ new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
var publishQueue = Promise.resolve();
var MAX_RESPONSE_CHARS = 256 * 1024;
var PROXY_TIMEOUT_MS = 1e4;
async function handleBlueprintGet(deps) {
  return jsonResult({
    ok: true,
    mock: deps.mode === "browser",
    serverRevision: await deps.store.readRevision(),
    blueprint: await deps.store.readBlueprint()
  });
}
async function handleBlueprintPublish(deps, req) {
  const expected = deps.proxy.saveKey;
  if (!expected) {
    return jsonResult(
      {
        ok: false,
        error: "\u672A\u914D\u7F6E\u4FDD\u5B58\u5BC6\u94A5\uFF0C\u5DF2\u7981\u6B62\u4FDD\u5B58\uFF1B\u666E\u901A\u7528\u6237\u4EC5\u53EF\u901A\u8FC7\u63A7\u4EF6\u5185\u7F6E API \u8BBF\u95EE\u540E\u7AEF"
      },
      403
    );
  }
  const provided = header(req, "x-blueprint-save-key").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return jsonResult(
      {
        ok: false,
        error: deps.mode === "browser" ? "\u4FDD\u5B58\u5BC6\u94A5\u9519\u8BEF\uFF08\u6F14\u793A\u5BC6\u94A5\uFF1Aatlas-demo-key\uFF09\uFF1B\u65E0\u5BC6\u94A5\u4EC5\u53EF\u4F7F\u7528\u63A7\u4EF6\u5185\u7F6E API \u8BBF\u95EE\u540E\u7AEF" : "\u4FDD\u5B58\u5BC6\u94A5\uFF08Save Key\uFF09\u9519\u8BEF\u6216\u7F3A\u5931\uFF1B\u65E0\u5BC6\u94A5\u4EC5\u53EF\u4F7F\u7528\u63A7\u4EF6\u5185\u9884\u8BBE API\uFF0C\u672C\u5730\u4FEE\u6539\u5DF2\u4FDD\u7559\u5728\u6D4F\u89C8\u5668"
      },
      401
    );
  }
  const body = parseJsonBody(req);
  if (!body || typeof body.blueprint !== "object" || body.blueprint === null) {
    return jsonResult({ ok: false, error: "\u65E0\u6548\u7684\u84DD\u56FE\u6570\u636E" }, 400);
  }
  const runAtomic = async () => {
    const written = await deps.store.writeBlueprint(body.blueprint);
    if (!written) {
      return jsonResult({ ok: false, error: "\u5B58\u50A8\u5DF2\u6EE1\uFF0C\u65E0\u6CD5\u5199\u5165\u5E95\u5EA7" }, 507);
    }
    const nextRev = await deps.store.readRevision() + 1;
    await deps.store.writeRevision(nextRev);
    return jsonResult({ ok: true, mock: deps.mode === "browser", serverRevision: nextRev });
  };
  const nextPromise = publishQueue.then(runAtomic, runAtomic);
  publishQueue = nextPromise.catch(() => {
  });
  return nextPromise;
}
async function handleProxyStatus(deps) {
  return jsonResult({
    enabled: true,
    mock: deps.mode === "browser",
    hasUpstreamSecret: deps.proxy.hasUpstreamSecret,
    allowedHosts: deps.proxy.allowedHosts
  });
}
async function handleProxy(deps, req) {
  const rl = deps.rateLimiter.check(req.clientId || "unknown");
  if (!rl.ok) {
    return jsonResult(
      {
        ok: false,
        error: `\u4EE3\u7406\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF08\u4E0A\u9650 ${deps.proxy.rateLimitPerMin} \u6B21/\u5206\u949F\uFF09\uFF0C\u8BF7 ${rl.retryAfterSec ?? 10} \u79D2\u540E\u91CD\u8BD5`
      },
      429,
      { "retry-after": String(rl.retryAfterSec ?? 10) }
    );
  }
  const body = parseJsonBody(req);
  if (!body || typeof body !== "object") {
    return jsonResult({ ok: false, error: "\u8BF7\u6C42\u4F53\u683C\u5F0F\u65E0\u6548" }, 400);
  }
  const method = typeof body.method === "string" ? body.method.toUpperCase().trim() : "POST";
  if (!ALLOWED_METHODS.has(method)) {
    return jsonResult({ ok: false, error: `\u4E0D\u652F\u6301\u7684 HTTP \u65B9\u6CD5\uFF1A${method}` }, 400);
  }
  const rawUrlStr = String(body.url ?? "").trim();
  const upstreamBase = (deps.proxy.upstreamBaseUrl ?? "").trim().replace(/\/+$/, "");
  let upstreamHost = "";
  if (upstreamBase) {
    try {
      upstreamHost = new URL(upstreamBase).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    } catch {
      upstreamHost = "";
    }
  }
  let resolvedUrlStr = rawUrlStr;
  if (rawUrlStr.startsWith("/") && !rawUrlStr.startsWith("//")) {
    if (!upstreamBase) {
      return jsonResult({ ok: false, error: "\u76EE\u6807 URL \u683C\u5F0F\u65E0\u6548\uFF08\u672A\u914D\u7F6E\u4E0A\u6E38\u57FA\u7840\u5730\u5740\uFF0C\u76F8\u5BF9\u8DEF\u5F84\u4E0D\u53EF\u7528\uFF09" }, 400);
    }
    resolvedUrlStr = `${upstreamBase}${rawUrlStr}`;
  }
  let target;
  try {
    target = new URL(resolvedUrlStr);
  } catch {
    return jsonResult({ ok: false, error: "\u76EE\u6807 URL \u683C\u5F0F\u65E0\u6548" }, 400);
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return jsonResult({ ok: false, error: "\u53EA\u5141\u8BB8 http/https \u534F\u8BAE" }, 400);
  }
  const hostLower = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const effectiveAllowlist = upstreamHost ? Array.from(/* @__PURE__ */ new Set([...deps.proxy.allowedHosts, upstreamHost])) : deps.proxy.allowedHosts;
  const hostAllowed = effectiveAllowlist.some(
    (allowed) => allowed === "*" || hostLower === allowed || hostLower.endsWith(`.${allowed}`)
  );
  if (!hostAllowed) {
    return jsonResult(
      {
        ok: false,
        error: `\u76EE\u6807\u57DF\u540D\u4E0D\u5728\u767D\u540D\u5355\u5185\uFF1A${target.hostname}\uFF08\u53EF\u9009\uFF1A${effectiveAllowlist.join(", ")}\uFF09`
      },
      403
    );
  }
  const outHeaders = {};
  if (typeof body.headers === "object" && body.headers) {
    for (const [k, v] of Object.entries(body.headers)) {
      if (typeof v === "string") outHeaders[k] = v;
    }
  }
  const outBody = method !== "GET" && method !== "HEAD" && typeof body.body === "string" ? toBytes(body.body) : void 0;
  let upstream;
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("__timeout__")), PROXY_TIMEOUT_MS);
  });
  try {
    upstream = await Promise.race([
      deps.fetcher.fetch(target.toString(), { method, headers: outHeaders, body: outBody }),
      timeout
    ]);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "__timeout__";
    return jsonResult(
      {
        ok: false,
        error: isTimeout ? `\u4EE3\u7406\u8BF7\u6C42\u8D85\u65F6\uFF08${PROXY_TIMEOUT_MS / 1e3}s\uFF09` : deps.mode === "browser" ? "\u4EE3\u7406\u8BF7\u6C42\u5931\u8D25\uFF1A\u9759\u6001\u7AD9\u53D7\u6D4F\u89C8\u5668 CORS \u9650\u5236\uFF0C\u76EE\u6807\u57DF\u540D\u9700\u5141\u8BB8\u8DE8\u57DF\u8BBF\u95EE" : `\u4EE3\u7406\u8BF7\u6C42\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`
      },
      isTimeout ? 504 : 502
    );
  } finally {
    if (timeoutId !== void 0) clearTimeout(timeoutId);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return jsonResult({ ok: false, error: "\u5B89\u5168\u9650\u5236\uFF1A\u5DF2\u62E6\u622A\u4E0A\u6E38 3xx \u91CD\u5B9A\u5411" }, 502);
  }
  let text = fromBytes(upstream.body);
  if (text.length > MAX_RESPONSE_CHARS) {
    text = `${text.slice(0, MAX_RESPONSE_CHARS)}
\u2026(\u54CD\u5E94\u5DF2\u622A\u65AD\u81F3 256KB)`;
  }
  const contentType = (upstream.headers["content-type"] ?? "").toLowerCase();
  let responseBody = text;
  if (contentType.includes("application/json")) {
    try {
      responseBody = JSON.parse(text);
    } catch {
      responseBody = text;
    }
  }
  return jsonResult({
    ok: upstream.status >= 200 && upstream.status < 300,
    status: upstream.status,
    responseBody,
    mock: deps.mode === "browser"
  });
}
function timingSafeEqualStr(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
async function handleApiRequest(deps, req) {
  const pathname = new URL(req.path, "http://x").pathname.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  const requireMethod = (want) => method === want ? null : jsonResult({ ok: false, error: "Method Not Allowed" }, 405);
  const roomBpMatch = pathname.match(/^\/api\/rooms\/(.+)\/blueprint(\/publish)?$/);
  if (roomBpMatch) {
    const rawRoom = roomBpMatch[1];
    const isPublish = Boolean(roomBpMatch[2]);
    const roomStore = deps.getRoomStore ? deps.getRoomStore(rawRoom) : deps.store;
    return handleApiRequest(
      { ...deps, store: roomStore },
      { ...req, path: isPublish ? "/api/blueprint/publish" : "/api/blueprint" }
    );
  }
  const roomHistMatch = pathname.match(/^\/api\/rooms\/(.+)\/(history|rollback)$/);
  if (roomHistMatch || pathname === "/api/history" || pathname === "/api/rollback") {
    const kind = roomHistMatch ? roomHistMatch[2] : pathname.endsWith("/history") ? "history" : "rollback";
    if (kind === "history") {
      if (method !== "GET") return jsonResult({ ok: false, error: "Method Not Allowed" }, 405);
      return jsonResult({ ok: true, entries: [] }, 200);
    }
    if (method !== "POST") return jsonResult({ ok: false, error: "Method Not Allowed" }, 405);
    return jsonResult({ ok: false, error: "\u7EAF\u9759\u6001\u6A21\u5F0F\u4E0D\u652F\u6301\u670D\u52A1\u7AEF\u7248\u672C\u56DE\u6863" }, 403);
  }
  switch (pathname) {
    case "/api/auth/session": {
      if (method !== "POST") {
        return {
          status: 405,
          headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
          body: new TextEncoder().encode(JSON.stringify({ ok: false, error: "Method Not Allowed" }))
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: new TextEncoder().encode(JSON.stringify({ ok: true, token: "", expiresInSec: 0, mode: "open" }))
      };
    }
    case "/api/blueprint": {
      const bad = requireMethod("GET");
      return bad ?? handleBlueprintGet(deps);
    }
    case "/api/blueprint/publish": {
      const bad = requireMethod("POST");
      return bad ?? handleBlueprintPublish(deps, req);
    }
    case "/api/proxy/status": {
      const bad = requireMethod("GET");
      return bad ?? handleProxyStatus(deps);
    }
    case "/api/proxy": {
      const bad = requireMethod("POST");
      return bad ?? handleProxy(deps, req);
    }
    default:
      return null;
  }
}

// server/server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path3.dirname(__filename);
var PORT = Number(process.env.PORT || 8787);
var IS_PROD = process.env.NODE_ENV === "production";
var PDF_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
var PDF_UPLOAD_MAX_LABEL = "50MB";
var DATA_DIR = path3.resolve(process.env.ATLAS_DATA_DIR || path3.join(__dirname, "../.atlas-data"));
var roomBlueprintRegistry = createRoomBlueprintStoreRegistry(DATA_DIR);
var sharedStore = roomBlueprintRegistry.getStore();
var roomServer = null;
var INTERNAL_RPC_SECRET = crypto4.randomBytes(24).toString("hex");
var RPC_DROP_RES_HEADERS = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "date",
  "etag"
]);
function makeRpcHandler(port) {
  return (frame) => new Promise((resolve) => {
    const rawPath = String(frame.path || "/");
    let normalizedPath = "/";
    try {
      const parsed = new URL(rawPath, "http://127.0.0.1");
      normalizedPath = `${parsed.pathname}${parsed.search}`;
    } catch {
      normalizedPath = "/";
    }
    if (!normalizedPath.startsWith("/api/")) {
      resolve({
        t: "rpc_res",
        id: frame.id,
        status: 403,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: "RPC \u53EA\u5141\u8BB8\u8BBF\u95EE /api/* \u8DEF\u5F84" }),
        bodyEncoding: "text"
      });
      return;
    }
    const isBase64 = frame.bodyEncoding === "base64";
    const bodyBuf = frame.rawBody ? Buffer.from(frame.rawBody) : frame.body ? Buffer.from(frame.body, isBase64 ? "base64" : "utf8") : Buffer.alloc(0);
    const headers = {};
    for (const [k, v] of Object.entries(frame.headers || {})) {
      const lk = k.toLowerCase();
      if (lk === "host" || lk === "content-length" || lk === "transfer-encoding") continue;
      if (typeof v === "string") headers[lk] = v;
    }
    headers["x-atlas-rpc"] = "1";
    headers["x-atlas-rpc-secret"] = INTERNAL_RPC_SECRET;
    if (frame.clientIp) headers["x-atlas-rpc-ip"] = frame.clientIp;
    if (bodyBuf.length > 0) headers["content-length"] = bodyBuf.length;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const MAX_RPC_RES_BYTES = 64 * 1024 * 1024;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: String(frame.method || "GET").toUpperCase(),
        path: normalizedPath,
        headers,
        timeout: 6e4
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;
        res.on("data", (c) => {
          totalBytes += c.byteLength;
          if (totalBytes > MAX_RPC_RES_BYTES) {
            req.destroy(new Error("RPC \u54CD\u5E94\u4F53\u8D85\u8FC7\u4E0A\u9650"));
            return;
          }
          chunks.push(c);
        });
        res.on("error", (err) => {
          done({
            t: "rpc_res",
            id: frame.id,
            status: 502,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ ok: false, error: `RPC \u54CD\u5E94\u6D41\u5F02\u5E38\uFF1A${err.message}` }),
            bodyEncoding: "text"
          });
        });
        res.on("aborted", () => {
          done({
            t: "rpc_res",
            id: frame.id,
            status: 502,
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ ok: false, error: "RPC \u54CD\u5E94\u6D41\u5F02\u5E38\u4E2D\u65AD" }),
            bodyEncoding: "text"
          });
        });
        res.on("end", () => {
          const buf = Buffer.concat(chunks, totalBytes);
          const resHeaders = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (RPC_DROP_RES_HEADERS.has(k.toLowerCase())) continue;
            if (typeof v === "string") resHeaders[k] = v;
            else if (Array.isArray(v)) resHeaders[k] = v.join(", ");
          }
          recordRpcStatus(res.statusCode ?? 0);
          const ct = String(resHeaders["content-type"] || "").toLowerCase();
          const isText = ct.includes("json") || ct.startsWith("text/") || ct.includes("javascript") || ct.includes("xml") || buf.length === 0;
          if (isText) {
            done({
              t: "rpc_res",
              id: frame.id,
              status: res.statusCode ?? 502,
              headers: resHeaders,
              body: buf.toString("utf8"),
              bodyEncoding: "text"
            });
          } else {
            done({
              t: "rpc_res",
              id: frame.id,
              status: res.statusCode ?? 502,
              headers: resHeaders,
              body: "",
              rawBody: new Uint8Array(buf),
              bodyEncoding: "binary"
            });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error("\u4E0A\u6E38\u5904\u7406\u8D85\u65F6"));
    });
    req.on("error", (err) => {
      done({
        t: "rpc_res",
        id: frame.id,
        status: 502,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ ok: false, error: `RPC \u56DE\u73AF\u5931\u8D25\uFF1A${err.message}` }),
        bodyEncoding: "text"
      });
    });
    if (bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}
var rpcForwarded = 0;
function recordRpcStatus(_status) {
  rpcForwarded += 1;
}
async function startServer() {
  const app = express();
  const trustProxy = String(process.env.TRUST_PROXY || "").trim().toLowerCase() === "true" || process.env.TRUST_PROXY === "1";
  if (trustProxy) {
    app.set("trust proxy", 1);
  }
  const corsAllowedOrigins = new Set(
    String(process.env.CORS_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  app.use((req, res, next) => {
    const origin = String(req.header("origin") || "").trim();
    if (origin && corsAllowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Proxy-Token, X-Proxy-Access-Key, X-Agent-Api-Key, X-Blueprint-Save-Key, X-Room-Path"
      );
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }
    next();
  });
  const getRealClientIp = (req) => {
    const remote = req.socket.remoteAddress || "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (isLoopback && req.header("x-atlas-rpc-secret") === INTERNAL_RPC_SECRET) {
      const rpcIp = String(req.header("x-atlas-rpc-ip") || "").trim();
      if (rpcIp) return rpcIp;
    }
    return req.ip || remote || "unknown";
  };
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/pdf/upload", express.raw({ type: "application/pdf", limit: PDF_UPLOAD_MAX_BYTES }));
  app.use("/api/pdf/unpack-upload", express.raw({ type: "application/pdf", limit: PDF_UPLOAD_MAX_BYTES }));
  const blueprintSaveKey = (process.env.BLUEPRINT_SAVE_KEY || "").trim();
  const agentApiKey = (process.env.AGENT_API_KEY || "").trim();
  const upstreamBaseUrl = (process.env.PROXY_UPSTREAM_BASE_URL || "").trim();
  const allowedHosts = parseAllowedHosts(process.env.PROXY_ALLOWED_HOSTS);
  const proxyApiKey = (process.env.PROXY_API_KEY || "").trim();
  const proxyAccessKey = (process.env.PROXY_ACCESS_KEY || "").trim();
  const authSessionSecret = (process.env.AUTH_SESSION_SECRET || "").trim();
  const proxyRateLimitPerMin = Math.max(1, Number(process.env.PROXY_RATE_LIMIT_PER_MIN || 30));
  const proxyRateHits = /* @__PURE__ */ new Map();
  const verifyProxyClientToken = (provided) => {
    if (!authSessionSecret) return true;
    if (!provided) return false;
    return verifySignedSessionToken(authSessionSecret, provided).valid;
  };
  const verifyTimingSafeKey = (expected, provided) => {
    if (!expected || !provided) return false;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && crypto4.timingSafeEqual(a, b);
  };
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      status: "up",
      uptimeSec: Math.round(process.uptime()),
      authMode: authSessionSecret ? "session" : "open"
    });
  });
  const extractRequestProxyToken = (req) => {
    const fromHeader = String(req.header("x-proxy-token") || "").trim();
    if (fromHeader) return fromHeader;
    const fromCookie = parseCookieValue(req.header("cookie"), "atlas_session").trim();
    if (fromCookie) return fromCookie;
    return "";
  };
  app.post("/api/auth/session", (req, res) => {
    const rl = checkProxyRateLimit(getRealClientIp(req));
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `\u4F1A\u8BDD\u7B7E\u53D1\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 ${rl.retryAfterSec} \u79D2\u540E\u91CD\u8BD5` });
      return;
    }
    if (!authSessionSecret) {
      res.json({ ok: true, token: "", expiresInSec: 0, mode: "open" });
      return;
    }
    const origin = String(req.header("origin") || "").trim();
    const host = String(req.header("host") || "").trim();
    const isSameOrigin = Boolean(origin && host && (origin === `http://${host}` || origin === `https://${host}`));
    const isAllowedCorsOrigin = Boolean(origin && corsAllowedOrigins.has(origin));
    if (!origin || !isSameOrigin && !isAllowedCorsOrigin) {
      res.status(403).json({ ok: false, error: "\u7F3A\u5C11\u6216\u975E\u6CD5\u7684 Origin\uFF0C\u62D2\u7EDD\u7B7E\u53D1\u4F1A\u8BDD\u4EE4\u724C" });
      return;
    }
    const sub = String(req.body?.cid || getRealClientIp(req) || "atlas-client");
    const ttlSec = 3600;
    const token = issueSignedSessionToken(authSessionSecret, sub, ttlSec);
    const isHttps = req.secure || String(req.header("x-forwarded-proto") || "").toLowerCase() === "https";
    const sameSite = isAllowedCorsOrigin && isHttps ? "SameSite=None" : "SameSite=Strict";
    const cookieParts = [
      `atlas_session=${encodeURIComponent(token)}`,
      "HttpOnly",
      sameSite,
      "Path=/",
      `Max-Age=${ttlSec}`
    ];
    if (isHttps || sameSite === "SameSite=None") cookieParts.push("Secure");
    res.setHeader("Set-Cookie", cookieParts.join("; "));
    res.json({ ok: true, token, expiresInSec: ttlSec, mode: "signed" });
  });
  let lastRateSweepAt = Date.now();
  const checkProxyRateLimit = (ip) => {
    const now = Date.now();
    const windowMs = 6e4;
    if (now - lastRateSweepAt > 3e5 || proxyRateHits.size > 200) {
      lastRateSweepAt = now;
      for (const [key, timestamps] of proxyRateHits) {
        const fresh = timestamps.filter((ts) => now - ts < windowMs);
        if (fresh.length === 0) proxyRateHits.delete(key);
        else proxyRateHits.set(key, fresh);
      }
    }
    const list = (proxyRateHits.get(ip) ?? []).filter((ts) => now - ts < windowMs);
    if (list.length >= proxyRateLimitPerMin) {
      const oldest = list[0];
      proxyRateHits.set(ip, list);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1e3)) };
    }
    list.push(now);
    proxyRateHits.set(ip, list);
    return { ok: true };
  };
  const proxyApiKeyHeader = (process.env.PROXY_API_KEY_HEADER || "Authorization").trim() || "Authorization";
  const proxyApiKeyPrefix = process.env.PROXY_API_KEY_PREFIX !== void 0 ? process.env.PROXY_API_KEY_PREFIX : proxyApiKeyHeader.toLowerCase() === "authorization" ? "Bearer " : "";
  const pinnedOutboundRequest = async (targetUrl, opts) => {
    const lookupHost = targetUrl.hostname.replace(/^\[|\]$/g, "");
    let records;
    try {
      records = await dns.lookup(lookupHost, { all: true });
    } catch {
      return { ok: false, kind: "dns_failed", error: "\u76EE\u6807\u57DF\u540D\u89E3\u6790\u5931\u8D25" };
    }
    if (records.length === 0 || records.some((r) => isPrivateOrReservedIP(r.address))) {
      return {
        ok: false,
        kind: "dns_blocked",
        error: "\u5B89\u5168\u9650\u5236\uFF1A\u76EE\u6807\u57DF\u540D\u89E3\u6790\u5230\u53D7\u4FDD\u62A4\u7684\u5185\u7F51\u6216\u5143\u6570\u636E\u5730\u5740\uFF0C\u5DF2\u62D2\u7EDD\u4EE3\u7406"
      };
    }
    const pinned = records[0];
    const isHttps = targetUrl.protocol === "https:";
    const port = targetUrl.port ? Number(targetUrl.port) : isHttps ? 443 : 80;
    const reqHeaders = {
      ...opts.headers,
      host: targetUrl.host
    };
    const bodyBuf = opts.body && opts.body.byteLength > 0 ? Buffer.from(opts.body) : void 0;
    if (bodyBuf) reqHeaders["content-length"] = bodyBuf.byteLength;
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const pinnedLookup = (_hostname, lookupOpts, cb) => {
        const wantsAll = typeof lookupOpts === "object" && lookupOpts !== null && Boolean(lookupOpts.all);
        if (wantsAll) {
          cb(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          cb(null, pinned.address, pinned.family);
        }
      };
      const reqFn = isHttps ? https.request : http.request;
      const req = reqFn(
        {
          hostname: lookupHost,
          port,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: opts.method,
          headers: reqHeaders,
          lookup: pinnedLookup,
          ...isHttps ? { servername: lookupHost } : {}
        },
        (res) => {
          const contentLen = Number(res.headers["content-length"] || 0);
          if (Number.isFinite(contentLen) && contentLen > opts.maxBytes) {
            res.destroy();
            done({ ok: false, kind: "too_large", error: "\u4E0A\u6E38\u54CD\u5E94\u4F53\u8D85\u8FC7\u5B89\u5168\u4E0A\u9650" });
            return;
          }
          const chunks = [];
          let total = 0;
          res.on("data", (chunk) => {
            total += chunk.length;
            if (total > opts.maxBytes) {
              res.destroy();
              done({ ok: false, kind: "too_large", error: "\u4E0A\u6E38\u54CD\u5E94\u4F53\u8D85\u8FC7\u5B89\u5168\u4E0A\u9650" });
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const outHeaders = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (v === void 0) continue;
              outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            done({
              ok: true,
              status: res.statusCode ?? 502,
              headers: outHeaders,
              buffer: Buffer.concat(chunks)
            });
          });
          res.on("error", (err) => {
            done({ ok: false, kind: "network", error: err.message || "\u4E0A\u6E38\u8BFB\u53D6\u5931\u8D25" });
          });
        }
      );
      const timer = setTimeout(() => {
        req.destroy(new Error("\u4E0A\u6E38\u8BF7\u6C42\u8D85\u65F6"));
      }, opts.timeoutMs ?? PROXY_DEFAULT_TIMEOUT_MS);
      req.on("error", (err) => {
        done({ ok: false, kind: "network", error: err.message || "\u4E0A\u6E38\u8BF7\u6C42\u5931\u8D25" });
      });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  };
  const serverFetcher = {
    async fetch(url, init) {
      const target = validateProxyTargetUrl(url, { upstreamBaseUrl, allowedHosts });
      if (!target.ok) throw new Error(target.error);
      const headerCheck = sanitizeProxyHeaders(init.headers);
      if (!headerCheck.ok) throw new Error(headerCheck.error);
      const outboundHeaders = { ...headerCheck.headers };
      if (proxyApiKey && target.injectSecret) {
        const hasClientOverride = Object.keys(outboundHeaders).some(
          (k) => k.toLowerCase() === proxyApiKeyHeader.toLowerCase()
        );
        if (!hasClientOverride) {
          outboundHeaders[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
        }
      }
      const out = await pinnedOutboundRequest(target.url, {
        method: init.method,
        headers: outboundHeaders,
        body: init.body,
        maxBytes: 2 * 1024 * 1024
      });
      if (!out.ok) {
        if (out.kind === "too_large") {
          throw new Error("\u4E0A\u6E38\u54CD\u5E94\u4F53\u8D85\u8FC7 2MB \u5B89\u5168\u4E0A\u9650\uFF0C\u5DF2\u4E2D\u6B62\u8BFB\u53D6");
        }
        throw new Error(out.error);
      }
      return { status: out.status, headers: out.headers, body: new Uint8Array(out.buffer) };
    }
  };
  const apiDeps = {
    store: sharedStore,
    proxy: {
      allowedHosts,
      upstreamBaseUrl,
      hasUpstreamSecret: Boolean(proxyApiKey),
      saveKey: blueprintSaveKey,
      rateLimitPerMin: proxyRateLimitPerMin
    },
    // 复用已有的 checkProxyRateLimit（带定期清理），只做接口适配，不另起一份实现。
    rateLimiter: { check: (clientId) => checkProxyRateLimit(clientId) },
    fetcher: serverFetcher,
    mode: "server"
  };
  const toApiRequest = (req) => {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    let body = new Uint8Array(0);
    if (Buffer.isBuffer(req.body)) {
      body = new Uint8Array(req.body);
    } else if (req.body && typeof req.body === "object") {
      body = new TextEncoder().encode(JSON.stringify(req.body));
    }
    return {
      method: req.method,
      path: req.originalUrl || req.url,
      headers,
      body,
      clientId: getRealClientIp(req)
    };
  };
  const writeApiResult = (res, result) => {
    res.status(result.status);
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    res.end(Buffer.from(result.body));
  };
  app.use("/api/proxy", (req, res, next) => {
    if (req.path === "/status") {
      next();
      return;
    }
    const providedAccessKey = String(
      req.header("x-proxy-access-key") || req.header("x-blueprint-save-key") || ""
    ).trim();
    if (proxyAccessKey) {
      if (!verifyTimingSafeKey(proxyAccessKey, providedAccessKey)) {
        res.status(401).json({
          ok: false,
          error: "\u4EE3\u7406\u8C03\u7528\u672A\u6388\u6743\uFF1A\u7F3A\u5C11\u6216\u9519\u8BEF\u7684 X-Proxy-Access-Key"
        });
        return;
      }
      next();
      return;
    }
    if (proxyApiKey) {
      if (!blueprintSaveKey) {
        res.status(403).json({
          ok: false,
          error: "\u670D\u52A1\u7AEF\u5DF2\u914D\u7F6E PROXY_API_KEY\uFF0C\u4F46\u672A\u914D\u7F6E PROXY_ACCESS_KEY \u6216 BLUEPRINT_SAVE_KEY\uFF0C\u5DF2\u62D2\u7EDD\u533F\u540D\u4EE3\u7406\u8C03\u7528"
        });
        return;
      }
      if (!verifyTimingSafeKey(blueprintSaveKey, providedAccessKey)) {
        res.status(401).json({
          ok: false,
          error: "\u8BE5\u4EE3\u7406\u6302\u8F7D\u4E86\u4E0A\u6E38\u5BC6\u94A5 PROXY_API_KEY\uFF0C\u9700\u8981\u643A\u5E26 X-Proxy-Access-Key \u6216 X-Blueprint-Save-Key"
        });
        return;
      }
      next();
      return;
    }
    const provided = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(provided)) {
      res.status(401).json({
        ok: false,
        error: "\u4EE3\u7406\u8C03\u7528\u672A\u6388\u6743\uFF1A\u7F3A\u5C11\u6216\u65E0\u6548\u7684\u4F1A\u8BDD\u4EE4\u724C"
      });
      return;
    }
    next();
  });
  const resolveRoomApiDeps = (roomPath) => {
    const normalized = normalizeRoomPath(roomPath);
    return {
      ...apiDeps,
      store: roomBlueprintRegistry.getStore(normalized)
    };
  };
  const asyncHandler = (fn) => (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
  const safeDecodeRoomParam = (raw) => {
    try {
      return normalizeRoomPath(decodeURIComponent(raw));
    } catch {
      return null;
    }
  };
  const agentRoomQueues = /* @__PURE__ */ new Map();
  const runSerializedForRoom = async (roomKey, task) => {
    const prev = agentRoomQueues.get(roomKey) ?? Promise.resolve();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    const nextChain = prev.then(() => gate);
    agentRoomQueues.set(roomKey, nextChain);
    await prev;
    try {
      return await task();
    } finally {
      release();
      if (agentRoomQueues.get(roomKey) === nextChain) {
        agentRoomQueues.delete(roomKey);
      }
    }
  };
  const requireClientAuth = (req, res, next) => {
    const provided = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(provided)) {
      res.status(401).json({ ok: false, error: "\u672A\u6388\u6743\u8BBF\u95EE\uFF1A\u7F3A\u5C11\u6216\u65E0\u6548\u7684\u4F1A\u8BDD\u51ED\u8BC1" });
      return;
    }
    next();
  };
  app.get("/api/room/stats", requireClientAuth, (_req, res) => {
    if (!roomServer) {
      res.status(503).json({ ok: false, error: "\u623F\u95F4\u670D\u52A1\u5C1A\u672A\u5C31\u7EEA" });
      return;
    }
    res.json({ ok: true, ...roomServer.stats(), rpcForwarded });
  });
  app.get("/api/rooms", requireClientAuth, asyncHandler(async (_req, res) => {
    const persisted = await listPersistedRooms(DATA_DIR);
    res.json({
      ok: true,
      active: roomServer ? roomServer.stats() : { rooms: 0, clients: 0 },
      persisted
    });
  }));
  app.get(/^\/api\/rooms\/(.+)\/blueprint$/, requireClientAuth, asyncHandler(async (req, res) => {
    const roomPath = safeDecodeRoomParam(String(req.params[0] || ""));
    if (!roomPath) {
      res.status(400).json({ ok: false, error: "\u975E\u6CD5\u623F\u95F4\u8DEF\u5F84\u7F16\u7801" });
      return;
    }
    const apiReq = toApiRequest(req);
    const result = await handleApiRequest(resolveRoomApiDeps(roomPath), {
      ...apiReq,
      path: "/api/blueprint"
    });
    if (!result) {
      res.status(404).json({ ok: false, error: "\u672A\u5B9E\u73B0\u7684\u84DD\u56FE\u8BFB\u53D6\u63A5\u53E3" });
      return;
    }
    writeApiResult(res, result);
  }));
  app.post(/^\/api\/rooms\/(.+)\/blueprint\/publish$/, requireClientAuth, asyncHandler(async (req, res) => {
    const roomPath = safeDecodeRoomParam(String(req.params[0] || ""));
    if (!roomPath) {
      res.status(400).json({ ok: false, error: "\u975E\u6CD5\u623F\u95F4\u8DEF\u5F84\u7F16\u7801" });
      return;
    }
    await runSerializedForRoom(roomPath, async () => {
      const apiReq = toApiRequest(req);
      const result = await handleApiRequest(resolveRoomApiDeps(roomPath), {
        ...apiReq,
        path: "/api/blueprint/publish"
      });
      if (!result) {
        res.status(404).json({ ok: false, error: "\u672A\u5B9E\u73B0\u7684\u84DD\u56FE\u53D1\u5E03\u63A5\u53E3" });
        return;
      }
      if (result.status === 200) {
        const bp = req.body?.blueprint;
        if (bp) {
          await roomBlueprintRegistry.getStore(roomPath).recordHistory("publish", {
            actor: getRealClientIp(req),
            summary: "\u7BA1\u7406\u5458\u53D1\u5E03\u84DD\u56FE",
            blueprint: bp
          });
          roomServer?.syncPublishedBlueprint(roomPath, bp);
        }
      }
      writeApiResult(res, result);
    });
  }));
  const verifySaveKey = (providedKey) => {
    if (!blueprintSaveKey || !providedKey) return false;
    const a = Buffer.from(providedKey, "utf8");
    const b = Buffer.from(blueprintSaveKey, "utf8");
    return a.length === b.length && crypto4.timingSafeEqual(a, b);
  };
  app.get(/^\/api\/rooms\/(.+)\/history$/, requireClientAuth, asyncHandler(async (req, res) => {
    const roomPath = safeDecodeRoomParam(String(req.params[0] || ""));
    if (!roomPath) {
      res.status(400).json({ ok: false, error: "\u975E\u6CD5\u623F\u95F4\u8DEF\u5F84\u7F16\u7801" });
      return;
    }
    const entries = await roomBlueprintRegistry.getStore(roomPath).listHistory();
    res.json({ ok: true, room: roomPath, entries });
  }));
  app.get("/api/history", requireClientAuth, asyncHandler(async (req, res) => {
    const roomPath = normalizeRoomPath(String(req.query.room || req.header("x-room-path") || ""));
    const entries = await roomBlueprintRegistry.getStore(roomPath).listHistory();
    res.json({ ok: true, room: roomPath, entries });
  }));
  const verifyAgentRequestAuth = (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `Agent \u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 ${rl.retryAfterSec} \u79D2\u540E\u91CD\u8BD5` });
      return false;
    }
    const expectedKey = agentApiKey || blueprintSaveKey;
    if (!expectedKey) {
      res.status(403).json({ ok: false, error: "\u670D\u52A1\u7AEF\u672A\u914D\u7F6E AGENT_API_KEY \u6216 BLUEPRINT_SAVE_KEY\uFF0C\u7981\u6B62 Agent \u8BBF\u95EE" });
      return false;
    }
    const provided = String(
      req.header("x-agent-api-key") || req.header("x-blueprint-save-key") || ""
    ).trim();
    if (!verifyTimingSafeKey(expectedKey, provided)) {
      res.status(401).json({ ok: false, error: "Agent \u9274\u6743\u5931\u8D25\uFF1A\u7F3A\u5C11\u6216\u9519\u8BEF\u7684 X-Agent-Api-Key" });
      return false;
    }
    return true;
  };
  app.get("/api/agent/schema", (_req, res) => {
    res.json({
      ok: true,
      inspectEndpoint: "/api/rooms/<roomPath>/agent/state",
      opsEndpoint: "/api/rooms/<roomPath>/ops",
      defaultOpsEndpoint: "/api/ops",
      authHeader: "X-Agent-Api-Key",
      fallbackAuthHeader: "X-Blueprint-Save-Key",
      templates: listAgentTemplates(),
      tools: getAgentToolSchema()
    });
  });
  const handleAgentStateRequest = async (roomPath, req, res) => {
    if (!verifyAgentRequestAuth(req, res)) return;
    const normalizedRoom = normalizeRoomPath(roomPath);
    const store = roomBlueprintRegistry.getStore(normalizedRoom);
    const liveSnap = await roomServer?.flushRoomSnapshot(normalizedRoom);
    const currentBlueprint = liveSnap ?? await store.readBlueprint();
    const revision = await store.readRevision();
    const includeFull = String(req.query.full || "") === "1" || String(req.query.full || "") === "true";
    res.json({
      ok: true,
      room: normalizedRoom,
      revision,
      summary: summarizeBlueprintForAgent(currentBlueprint),
      templates: listAgentTemplates(),
      ...includeFull ? { blueprint: currentBlueprint } : {}
    });
  };
  app.get("/api/agent/state", asyncHandler(async (req, res) => {
    const requestedRoom = String(req.query.room || req.header("x-room-path") || DEFAULT_ROOM_PATH).trim();
    await handleAgentStateRequest(requestedRoom, req, res);
  }));
  app.get(/^\/api\/rooms\/(.+)\/agent\/state$/, asyncHandler(async (req, res) => {
    const raw = req.params[0] || DEFAULT_ROOM_PATH;
    const roomPath = safeDecodeRoomParam(raw);
    if (!roomPath) {
      res.status(400).json({ ok: false, error: "\u975E\u6CD5\u623F\u95F4\u8DEF\u5F84\u7F16\u7801" });
      return;
    }
    await handleAgentStateRequest(roomPath, req, res);
  }));
  const handleAgentOpsRequest = async (roomPath, req, res) => {
    if (!verifyAgentRequestAuth(req, res)) return;
    const clientIp = getRealClientIp(req);
    const body = req.body || {};
    const normalizedRoom = normalizeRoomPath(roomPath);
    const isDryRun = body.dryRun === true;
    await runSerializedForRoom(normalizedRoom, async () => {
      const store = roomBlueprintRegistry.getStore(normalizedRoom);
      const liveSnap = await roomServer?.flushRoomSnapshot(normalizedRoom);
      const currentBlueprint = liveSnap ?? await store.readBlueprint();
      const currentRev = await store.readRevision();
      if (body.expectedRevision !== void 0 && body.expectedRevision !== null) {
        const expected = Number(body.expectedRevision);
        if (!Number.isFinite(expected) || Math.trunc(expected) !== currentRev) {
          res.status(409).json({
            ok: false,
            error: `\u7248\u672C\u51B2\u7A81\uFF1A\u671F\u671B revision=${String(body.expectedRevision)}\uFF0C\u5F53\u524D\u6700\u65B0 revision=${currentRev}`,
            currentRevision: currentRev
          });
          return;
        }
      }
      const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : `agent:${clientIp}`;
      const applied = applyAgentOperations(currentBlueprint, body.ops, { actor });
      if (!applied.ok) {
        res.status(400).json({ ok: false, error: applied.error, failedIndex: applied.failedIndex });
        return;
      }
      if (isDryRun) {
        res.json({
          ok: true,
          dryRun: true,
          room: normalizedRoom,
          currentRevision: currentRev,
          results: applied.results,
          summary: applied.summary,
          preview: summarizeBlueprintForAgent(applied.blueprint)
        });
        return;
      }
      const nextRev = currentRev + 1;
      await store.writeBlueprint(applied.blueprint);
      await store.writeRevision(nextRev);
      const historyEntry = await store.recordHistory("agent", {
        actor,
        summary: typeof body.summary === "string" && body.summary.trim() ? body.summary.trim().slice(0, 140) : applied.summary,
        blueprint: applied.blueprint
      });
      roomServer?.syncPublishedBlueprint(normalizedRoom, applied.blueprint);
      res.json({
        ok: true,
        dryRun: false,
        room: normalizedRoom,
        revision: nextRev,
        results: applied.results,
        summary: applied.summary,
        historyVersion: historyEntry?.version ?? null
      });
    });
  };
  app.post("/api/ops", asyncHandler(async (req, res) => {
    const requestedRoom = String(req.query.room || req.header("x-room-path") || DEFAULT_ROOM_PATH).trim();
    await handleAgentOpsRequest(requestedRoom, req, res);
  }));
  app.post(/^\/api\/rooms\/(.+)\/ops$/, asyncHandler(async (req, res) => {
    const raw = req.params[0] || DEFAULT_ROOM_PATH;
    const roomPath = safeDecodeRoomParam(raw);
    if (!roomPath) {
      res.status(400).json({ ok: false, error: "\u975E\u6CD5\u623F\u95F4\u8DEF\u5F84\u7F16\u7801" });
      return;
    }
    await handleAgentOpsRequest(roomPath, req, res);
  }));
  const handleRollbackRequest = async (roomPath, req, res) => {
    const saveKey = String(req.header("x-blueprint-save-key") || "").trim();
    const agentKeyHeader = String(req.header("x-agent-api-key") || "").trim();
    if (!blueprintSaveKey && !agentApiKey) {
      res.status(403).json({ ok: false, error: "\u670D\u52A1\u7AEF\u672A\u914D\u7F6E BLUEPRINT_SAVE_KEY \u6216 AGENT_API_KEY\uFF0C\u7981\u6B62\u56DE\u6863" });
      return;
    }
    const okSave = Boolean(blueprintSaveKey && verifySaveKey(saveKey));
    const okAgent = Boolean((agentApiKey || blueprintSaveKey) && verifyTimingSafeKey(agentApiKey || blueprintSaveKey, agentKeyHeader));
    if (!okSave && !okAgent) {
      res.status(401).json({ ok: false, error: "\u7BA1\u7406\u5458\u6216 Agent \u5BC6\u94A5\u9519\u8BEF\uFF0C\u62D2\u7EDD\u56DE\u6863" });
      return;
    }
    const version = Number(req.body?.version);
    if (!Number.isFinite(version) || version < 1) {
      res.status(400).json({ ok: false, error: "\u7F3A\u5C11\u5408\u6CD5\u7684\u76EE\u6807\u7248\u672C\u53F7 version" });
      return;
    }
    await runSerializedForRoom(roomPath, async () => {
      const out = await roomBlueprintRegistry.getStore(roomPath).rollbackToVersion(Math.trunc(version), getRealClientIp(req));
      if (!out.ok) {
        res.status(404).json({ ok: false, error: out.error || "\u7248\u672C\u4E0D\u5B58\u5728" });
        return;
      }
      roomServer?.syncPublishedBlueprint(roomPath, out.blueprint);
      res.json({ ok: true, room: roomPath, revision: out.revision, blueprint: out.blueprint, entry: out.entry });
    });
  };
  const requireSessionOrAgentKey = (req, res, next) => {
    const providedAgentKey = String(req.header("x-agent-api-key") || "").trim();
    if (providedAgentKey && verifyTimingSafeKey(agentApiKey || blueprintSaveKey, providedAgentKey)) {
      next();
      return;
    }
    requireClientAuth(req, res, next);
  };
  app.post("/api/rollback", requireSessionOrAgentKey, asyncHandler(async (req, res) => {
    const roomPath = normalizeRoomPath(String(req.query.room || req.header("x-room-path") || ""));
    await handleRollbackRequest(roomPath, req, res);
  }));
  app.post(/^\/api\/rooms\/(.+)\/rollback$/, requireSessionOrAgentKey, asyncHandler(async (req, res) => {
    const roomPath = safeDecodeRoomParam(String(req.params[0] || ""));
    if (!roomPath) {
      res.status(400).json({ ok: false, error: "\u975E\u6CD5\u623F\u95F4\u8DEF\u5F84\u7F16\u7801" });
      return;
    }
    await handleRollbackRequest(roomPath, req, res);
  }));
  for (const routePath of [
    "/api/blueprint",
    "/api/blueprint/publish",
    "/api/proxy/status",
    "/api/proxy"
  ]) {
    const authMiddleware = routePath === "/api/proxy" ? (_req, _res, next) => next() : requireClientAuth;
    app.all(routePath, authMiddleware, asyncHandler(async (req, res) => {
      const requestedRoom = String(req.query.room || req.header("x-room-path") || "").trim();
      const targetRoom = normalizeRoomPath(requestedRoom);
      const runPublish = async () => {
        const deps = (routePath === "/api/blueprint" || routePath === "/api/blueprint/publish") && requestedRoom ? resolveRoomApiDeps(requestedRoom) : apiDeps;
        const result = await handleApiRequest(deps, toApiRequest(req));
        if (!result) {
          res.status(404).json({ ok: false, error: `\u672A\u5B9E\u73B0\u7684\u63A5\u53E3\uFF1A${routePath}` });
          return;
        }
        if (routePath === "/api/blueprint/publish" && result.status === 200) {
          const bp = req.body?.blueprint;
          if (bp) {
            await roomBlueprintRegistry.getStore(targetRoom).recordHistory("publish", {
              actor: getRealClientIp(req),
              summary: "\u7BA1\u7406\u5458\u53D1\u5E03\u84DD\u56FE",
              blueprint: bp
            });
            roomServer?.syncPublishedBlueprint(targetRoom, bp);
          }
        }
        writeApiResult(res, result);
      };
      if (routePath === "/api/blueprint/publish") {
        await runSerializedForRoom(targetRoom, runPublish);
      } else {
        await runPublish();
      }
    }));
  }
  const uploadedPdfStore = /* @__PURE__ */ new Map();
  const MAX_UPLOADED_PDFS = 20;
  app.get("/api/proxy/binary", async (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `\u4EE3\u7406\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 ${rl.retryAfterSec} \u79D2\u540E\u91CD\u8BD5` });
      return;
    }
    const rawUrl = String(req.query.url || "").trim();
    const target = validateProxyTargetUrl(rawUrl, { upstreamBaseUrl, allowedHosts });
    if (!target.ok) {
      res.status(target.status).json({ ok: false, error: target.error });
      return;
    }
    const headers = {};
    if (proxyApiKey && target.injectSecret) {
      headers[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
    }
    const out = await pinnedOutboundRequest(target.url, {
      method: "GET",
      headers,
      maxBytes: PDF_UPLOAD_MAX_BYTES
    });
    if (!out.ok) {
      if (out.kind === "dns_blocked") {
        res.status(403).json({ ok: false, error: "\u5B89\u5168\u9650\u5236\uFF1A\u76EE\u6807\u57DF\u540D\u89E3\u6790\u5230\u53D7\u4FDD\u62A4\u5730\u5740" });
        return;
      }
      if (out.kind === "too_large") {
        res.status(413).json({ ok: false, error: `PDF \u6587\u4EF6\u8D85\u8FC7 ${PDF_UPLOAD_MAX_LABEL} \u4EE3\u7406\u4E0A\u9650` });
        return;
      }
      res.status(502).json({ ok: false, error: out.error || "PDF \u4EE3\u7406\u62C9\u53D6\u5931\u8D25" });
      return;
    }
    if (out.status >= 300 && out.status < 400) {
      res.status(502).json({ ok: false, error: "\u5B89\u5168\u9650\u5236\uFF1A\u5DF2\u62E6\u622A\u4E0A\u6E38 3xx \u91CD\u5B9A\u5411" });
      return;
    }
    res.setHeader("Content-Type", sanitizeBinaryProxyContentType(out.headers["content-type"] ?? null));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", "inline");
    res.status(out.status).send(out.buffer);
  });
  app.post("/api/pdf/upload", (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: "\u4E0A\u4F20\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" });
      return;
    }
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: "\u672A\u6388\u6743\u4E0A\u4F20" });
      return;
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.byteLength === 0) {
      res.status(400).json({ ok: false, error: "\u7F3A\u5C11 PDF \u6570\u636E\uFF08\u8BF7\u4EE5 application/pdf \u63D0\u4EA4\u539F\u59CB\u5B57\u8282\uFF09" });
      return;
    }
    if (buf.byteLength > PDF_UPLOAD_MAX_BYTES) {
      res.status(413).json({ ok: false, error: `PDF \u6587\u4EF6\u5927\u5C0F\u9700\u5728 1B\u2013${PDF_UPLOAD_MAX_LABEL} \u4E4B\u95F4` });
      return;
    }
    if (buf.subarray(0, 4).toString("ascii") !== "%PDF") {
      res.status(400).json({ ok: false, error: "\u6587\u4EF6\u5934\u6821\u9A8C\u5931\u8D25\uFF0C\u4EC5\u5141\u8BB8\u6807\u51C6 PDF \u6587\u4EF6" });
      return;
    }
    const id = crypto4.randomBytes(8).toString("hex");
    let rawName = String(req.header("x-pdf-filename") || "document.pdf");
    try {
      rawName = decodeURIComponent(rawName);
    } catch {
    }
    const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "document.pdf";
    if (uploadedPdfStore.size >= MAX_UPLOADED_PDFS) {
      const oldestKey = uploadedPdfStore.keys().next().value;
      if (oldestKey) uploadedPdfStore.delete(oldestKey);
    }
    uploadedPdfStore.set(id, { filename, buf, createdAt: Date.now() });
    res.json({ ok: true, id, url: `/api/pdf/${id}` });
  });
  app.post("/api/pdf/unpack", async (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: `\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7 ${rl.retryAfterSec} \u79D2\u540E\u91CD\u8BD5` });
      return;
    }
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: "\u672A\u6388\u6743\u89E3\u5305\u8BF7\u6C42" });
      return;
    }
    const rawUrl = String(req.body?.url || "").trim();
    const target = validateProxyTargetUrl(rawUrl, { upstreamBaseUrl, allowedHosts });
    if (!target.ok) {
      res.status(target.status).json({ ok: false, error: target.error });
      return;
    }
    const headers = {};
    if (proxyApiKey && target.injectSecret) {
      headers[proxyApiKeyHeader] = `${proxyApiKeyPrefix}${proxyApiKey}`;
    }
    const out = await pinnedOutboundRequest(target.url, {
      method: "GET",
      headers,
      maxBytes: PDF_UPLOAD_MAX_BYTES
    });
    if (!out.ok) {
      if (out.kind === "dns_blocked") {
        res.status(403).json({ ok: false, error: "\u5B89\u5168\u9650\u5236\uFF1A\u76EE\u6807\u57DF\u540D\u89E3\u6790\u5230\u53D7\u4FDD\u62A4\u5730\u5740" });
        return;
      }
      if (out.kind === "too_large") {
        res.status(413).json({ ok: false, error: `PDF \u6587\u4EF6\u8D85\u8FC7 ${PDF_UPLOAD_MAX_LABEL} \u4E0A\u9650` });
        return;
      }
      res.status(502).json({ ok: false, error: out.error || "PDF \u89E3\u5305\u5931\u8D25" });
      return;
    }
    if (out.status >= 300 && out.status < 400) {
      res.status(502).json({ ok: false, error: "\u5B89\u5168\u9650\u5236\uFF1A\u5DF2\u62E6\u622A\u4E0A\u6E38 3xx \u91CD\u5B9A\u5411" });
      return;
    }
    if (out.status < 200 || out.status >= 300) {
      res.status(502).json({ ok: false, error: `\u62C9\u53D6 PDF \u5931\u8D25\uFF08HTTP ${out.status}\uFF09` });
      return;
    }
    try {
      const unpacked = await unpackPdfBufferToPages(out.buffer);
      res.json({
        ok: true,
        docId: unpacked.docId,
        totalPages: unpacked.totalPages,
        pageUrlTemplate: `/api/pdf/${unpacked.docId}/page/{page}`
      });
    } catch (err) {
      console.error("[Atlas] PDF unpack error:", err);
      res.status(502).json({ ok: false, error: "PDF \u6E32\u67D3\u6216\u89E3\u5305\u5931\u8D25" });
    }
  });
  app.post("/api/pdf/unpack-upload", async (req, res) => {
    const clientIp = getRealClientIp(req);
    const rl = checkProxyRateLimit(clientIp);
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfterSec ?? 10));
      res.status(429).json({ ok: false, error: "\u4E0A\u4F20\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" });
      return;
    }
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: "\u672A\u6388\u6743\u4E0A\u4F20" });
      return;
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.byteLength === 0) {
      res.status(400).json({ ok: false, error: "\u4E0A\u4F20\u5185\u5BB9\u4E3A\u7A7A\uFF08\u8BF7\u4EE5 application/pdf \u4E8C\u8FDB\u5236\u53D1\u9001\uFF09" });
      return;
    }
    if (buf.byteLength > PDF_UPLOAD_MAX_BYTES) {
      res.status(413).json({ ok: false, error: `PDF \u6587\u4EF6\u8D85\u8FC7 ${PDF_UPLOAD_MAX_LABEL} \u4E0A\u9650` });
      return;
    }
    try {
      const unpacked = await unpackPdfBufferToPages(buf);
      res.json({
        ok: true,
        docId: unpacked.docId,
        totalPages: unpacked.totalPages,
        pageUrlTemplate: `/api/pdf/${unpacked.docId}/page/{page}`
      });
    } catch (err) {
      console.error("[Atlas] PDF upload unpack error:", err);
      res.status(400).json({ ok: false, error: "PDF \u6E32\u67D3\u6216\u89E3\u5305\u5931\u8D25" });
    }
  });
  app.get("/api/pdf/:id/meta", (req, res) => {
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: "\u672A\u6388\u6743\u8BBF\u95EE PDF \u5143\u6570\u636E" });
      return;
    }
    const meta = getUnpackedPdfMeta(String(req.params.id || ""));
    if (!meta) {
      res.status(404).json({ ok: false, error: "\u672A\u627E\u5230\u5DF2\u89E3\u5305\u7684 PDF \u6587\u6863" });
      return;
    }
    res.json({ ok: true, ...meta });
  });
  app.get("/api/pdf/:id/page/:page", async (req, res) => {
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: "\u672A\u6388\u6743\u8BBF\u95EE PDF \u9875\u9762" });
      return;
    }
    const docId = String(req.params.id || "");
    const pageNum = Number(req.params.page);
    try {
      const hit = await getUnpackedPdfPage(docId, pageNum, req.query.dpi);
      if (!hit) {
        res.status(404).json({ ok: false, error: "\u672A\u627E\u5230\u5BF9\u5E94 PDF \u9875\u9762\u56FE\u7247" });
        return;
      }
      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.send(hit.buffer);
    } catch (err) {
      console.error("[Atlas] PDF page render error:", err);
      res.status(502).json({ ok: false, error: "PDF \u9875\u9762\u6E32\u67D3\u5931\u8D25" });
    }
  });
  app.get("/api/pdf/:id", (req, res) => {
    const providedProxyToken = extractRequestProxyToken(req);
    if (!verifyProxyClientToken(providedProxyToken)) {
      res.status(401).json({ ok: false, error: "\u672A\u6388\u6743\u8BBF\u95EE PDF \u6587\u4EF6" });
      return;
    }
    const id = String(req.params.id || "");
    const item = uploadedPdfStore.get(id);
    if (!item) {
      res.status(404).json({ ok: false, error: "PDF \u4E0D\u5B58\u5728\u6216\u5DF2\u8FC7\u671F" });
      return;
    }
    uploadedPdfStore.delete(id);
    uploadedPdfStore.set(id, item);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${item.filename}"`);
    res.send(item.buf);
  });
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path3.resolve(__dirname, "../dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path3.join(distDir, "index.html"));
    });
  }
  app.use(
    (err, _req, res, next) => {
      if (!err) {
        next();
        return;
      }
      if (res.headersSent) {
        next(err);
        return;
      }
      if (err.type === "entity.too.large") {
        res.status(413).json({ ok: false, error: `PDF \u6587\u4EF6\u5927\u5C0F\u9700\u5728 1B\u2013${PDF_UPLOAD_MAX_LABEL} \u4E4B\u95F4` });
        return;
      }
      const status = typeof err.status === "number" ? err.status : 500;
      res.status(status).json({ ok: false, error: err.message || "\u670D\u52A1\u7AEF\u5904\u7406\u5931\u8D25" });
    }
  );
  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Atlas Hybrid Canvas] running at http://localhost:${PORT}`);
    console.log(`[Atlas Hybrid Canvas] \u534F\u540C\u623F\u95F4 WebSocket: ws://localhost:${PORT}/ws`);
  });
  roomServer = attachRoomServer(httpServer, "/ws", makeRpcHandler(PORT), DATA_DIR, verifyProxyClientToken, (rp) => roomBlueprintRegistry.getStore(rp));
  const shutdown = () => {
    void roomServer.close().finally(() => {
      httpServer.close(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
void startServer();
