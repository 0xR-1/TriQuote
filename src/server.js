import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteTicker, scan, DEFAULT_WATCHLIST } from "./router.js";
import { walletStatus } from "./baw.js";
import { buildScanPayload } from "./cli.js";

const PORT = Number(process.env.PORT ?? 4173);
const SCAN_CACHE_TTL_MS = 60 * 1000;
const MAX_QUOTE_USDT = 1000;
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_FILE = join(PROJECT_ROOT, "public", "index.html");
const TRADE_LOG_FILE = join(PROJECT_ROOT, ".cache", "trades.jsonl");

function replayPathFromArgs() {
  const flagIndex = process.argv.indexOf("--replay");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) {
    return resolve(process.argv[flagIndex + 1]);
  }
  return process.env.TRIQUOTE_REPLAY ? resolve(process.env.TRIQUOTE_REPLAY) : null;
}

const REPLAY_FILE = replayPathFromArgs();
const scanCache = new Map();
const inflightScans = new Map();
let replaySnapshot = null;

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

async function loadReplaySnapshot() {
  if (!replaySnapshot) {
    const snapshot = JSON.parse(await readFile(REPLAY_FILE, "utf8"));
    if (!Array.isArray(snapshot.rows)) {
      throw new Error(`Replay file ${REPLAY_FILE} has no rows array`);
    }
    replaySnapshot = snapshot;
  }
  return replaySnapshot;
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
    const payload = buildScanPayload(rows, usdtAmount, startedAt);
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

async function handleScan(url, response) {
  if (REPLAY_FILE) {
    const snapshot = await loadReplaySnapshot();
    sendJson(response, 200, { ...snapshot, replay: true, cached: true });
    return;
  }
  const payload = await cachedScan(parseTickers(url.searchParams.get("tickers")), parseUsdt(url.searchParams.get("usdt")), url.searchParams.get("refresh") === "1");
  sendJson(response, 200, { ...payload, replay: false });
}

async function handleBest(url, response) {
  const ticker = parseTickers(url.searchParams.get("ticker"))[0];
  if (!ticker) {
    sendJson(response, 400, { error: "ticker is required" });
    return;
  }
  if (REPLAY_FILE) {
    const snapshot = await loadReplaySnapshot();
    const row = snapshot.rows.find((item) => item.ticker === ticker);
    sendJson(response, row ? 200 : 404, row ? { ...row, replay: true } : { error: `${ticker} is not in the replay snapshot` });
    return;
  }
  sendJson(response, 200, await quoteTicker(ticker, parseUsdt(url.searchParams.get("usdt"))));
}

async function handleTrades(response) {
  const live = await readTrades();
  if (REPLAY_FILE) {
    const snapshot = await loadReplaySnapshot();
    const recorded = Array.isArray(snapshot.trades) ? snapshot.trades : [];
    sendJson(response, 200, { trades: live.length > 0 ? live : recorded });
    return;
  }
  sendJson(response, 200, { trades: live });
}

async function handleWallet(response) {
  if (REPLAY_FILE) {
    sendJson(response, 200, { connected: false, replay: true });
    return;
  }
  const status = await walletStatus();
  sendJson(response, 200, { connected: status.success && status.data?.status === "CONNECTED", replay: false });
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
    await handleScan(url, response);
    return;
  }
  if (url.pathname === "/api/best") {
    await handleBest(url, response);
    return;
  }
  if (url.pathname === "/api/trades") {
    await handleTrades(response);
    return;
  }
  if (url.pathname === "/api/wallet") {
    await handleWallet(response);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(response, 500, { error: error.message });
  });
}).listen(PORT, "127.0.0.1", () => {
  const mode = REPLAY_FILE ? `replaying ${REPLAY_FILE}` : "live quotes via Agentic Wallet";
  console.log(`TriQuote dashboard running at http://localhost:${PORT} (${mode})`);
});
