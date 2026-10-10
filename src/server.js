import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteTicker, scan, DEFAULT_WATCHLIST, TOXIC_PREMIUM_BPS } from "./router.js";
import { walletStatus } from "./baw.js";

const PORT = Number(process.env.PORT ?? 4173);
const SCAN_CACHE_TTL_MS = 60 * 1000;
const MAX_QUOTE_USDT = 1000;
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_FILE = join(PROJECT_ROOT, "public", "index.html");
const TRADE_LOG_FILE = join(PROJECT_ROOT, ".cache", "trades.jsonl");

const scanCache = new Map();
const inflightScans = new Map();

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function parseUsdt(value) {
  const amount = Number(value ?? 5);
  if (!(amount > 0) || amount > MAX_QUOTE_USDT) {
    throw new Error(`usdt must be between 0 and ${MAX_QUOTE_USDT}`);
  }
  return amount;
}

function parseTickers(value) {
  if (!value) {
    return DEFAULT_WATCHLIST;
  }
  return value.split(",").map((ticker) => ticker.trim().toUpperCase()).filter((ticker) => /^[A-Z0-9.]{1,12}$/.test(ticker)).slice(0, 40);
}

async function cachedScan(tickers, usdtAmount, forceRefresh) {
  const key = `${tickers.join(",")}|${usdtAmount}`;
  const cached = scanCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.at < SCAN_CACHE_TTL_MS) {
    return { ...cached.payload, cached: true };
  }
  if (inflightScans.has(key)) {
    return inflightScans.get(key);
  }
  const job = (async () => {
    const startedAt = Date.now();
    const rows = await scan({ tickers, usdtAmount });
    const payload = {
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      usdtAmount,
      toxicThresholdBps: TOXIC_PREMIUM_BPS,
      rows
    };
    scanCache.set(key, { at: Date.now(), payload });
    return { ...payload, cached: false };
  })();
  inflightScans.set(key, job);
  try {
    return await job;
  } finally {
    inflightScans.delete(key);
  }
}

async function readTrades() {
  try {
    const text = await readFile(TRADE_LOG_FILE, "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line)).reverse();
  } catch {
    return [];
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Only GET is supported" });
    return;
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const html = await readFile(INDEX_FILE);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (url.pathname === "/api/scan") {
    const payload = await cachedScan(parseTickers(url.searchParams.get("tickers")), parseUsdt(url.searchParams.get("usdt")), url.searchParams.get("refresh") === "1");
    sendJson(response, 200, payload);
    return;
  }
  if (url.pathname === "/api/best") {
    const ticker = parseTickers(url.searchParams.get("ticker"))[0];
    if (!ticker) {
      sendJson(response, 400, { error: "ticker is required" });
      return;
    }
    sendJson(response, 200, await quoteTicker(ticker, parseUsdt(url.searchParams.get("usdt"))));
    return;
  }
  if (url.pathname === "/api/trades") {
    sendJson(response, 200, { trades: await readTrades() });
    return;
  }
  if (url.pathname === "/api/wallet") {
    const status = await walletStatus();
    sendJson(response, 200, { connected: status.success && status.data?.status === "CONNECTED" });
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(response, 500, { error: error.message });
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`TriQuote dashboard running at http://localhost:${PORT}`);
});
