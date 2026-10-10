import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RWA_LIST_URL = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai";
const BSC_CHAIN_ID = "56";
const CACHE_TTL_MS = 10 * 60 * 1000;
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_FILE = join(PROJECT_ROOT, ".cache", "rwa-list.json");

export const ISSUERS = {
  1: { key: "ondo", name: "Ondo" },
  2: { key: "xstocks", name: "xStocks" },
  3: { key: "bstocks", name: "bStocks" }
};

export const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";

async function readCache() {
  try {
    const cached = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    return cached;
  } catch {
    return null;
  }
}

async function writeCache(items) {
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), items }));
}

async function fetchRemoteList() {
  const response = await fetch(RWA_LIST_URL, {
    headers: {
      "Accept-Encoding": "identity",
      "User-Agent": "binance-web3/1.1 (Skill)"
    }
  });
  if (!response.ok) {
    throw new Error(`RWA list request failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body.success || !Array.isArray(body.data)) {
    throw new Error(`RWA list returned an unexpected payload (code ${body.code})`);
  }
  return body.data;
}

export async function loadRawList({ forceRefresh = false } = {}) {
  const cached = await readCache();
  const isFresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
  if (isFresh && !forceRefresh) {
    return cached.items;
  }
  try {
    const items = await fetchRemoteList();
    await writeCache(items);
    return items;
  } catch (error) {
    if (cached) {
      return cached.items;
    }
    throw error;
  }
}

function toListing(item) {
  const issuer = ISSUERS[item.type];
  return {
    ticker: item.ticker,
    symbol: item.symbol,
    issuer: issuer.key,
    issuerName: issuer.name,
    address: item.contractAddress,
    multiplier: Number(item.multiplier) || 1,
    decimals: item.d ?? 18
  };
}

export async function loadRegistry(options) {
  const items = await loadRawList(options);
  const byTicker = new Map();
  for (const item of items) {
    if (item.chainId !== BSC_CHAIN_ID || !ISSUERS[item.type] || !item.ticker) {
      continue;
    }
    const listing = toListing(item);
    const listings = byTicker.get(listing.ticker) ?? [];
    listings.push(listing);
    byTicker.set(listing.ticker, listings);
  }
  return byTicker;
}

export async function getListings(ticker, options) {
  const registry = await loadRegistry(options);
  return registry.get(ticker.toUpperCase()) ?? [];
}

export async function getMultiIssuerTickers(minIssuers = 2, options) {
  const registry = await loadRegistry(options);
  return [...registry.entries()]
    .filter(([, listings]) => listings.length >= minIssuers)
    .map(([ticker, listings]) => ({ ticker, issuers: listings.map((listing) => listing.issuer) }))
    .sort((a, b) => b.issuers.length - a.issuers.length || a.ticker.localeCompare(b.ticker));
}
