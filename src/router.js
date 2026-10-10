import { getListings, getMultiIssuerTickers, USDT_BSC } from "./registry.js";
import { quoteSwap } from "./baw.js";
import { getReference } from "./reference.js";

export const DEFAULT_WATCHLIST = ["NVDA", "TSLA", "AAPL", "MSFT", "META", "GOOGL", "AMZN", "SPY", "QQQ", "COIN"];
export const TOXIC_PREMIUM_BPS = 300;
export const SUSPECT_DISCOUNT_BPS = 500;
const DEFAULT_CONCURRENCY = 3;

async function rawQuote(listing, usdtAmount) {
  const result = await quoteSwap({ fromToken: USDT_BSC, toToken: listing.address, fromTokenQty: usdtAmount });
  const base = {
    issuer: listing.issuer,
    issuerName: listing.issuerName,
    symbol: listing.symbol,
    address: listing.address,
    latencyMs: result.latencyMs
  };
  if (!result.success) {
    return { ...base, available: false, error: result.error?.message ?? "Unknown error", errorCode: result.error?.code ?? null };
  }
  const tokensOut = Number(result.data.toCoinAmount);
  if (!(tokensOut > 0)) {
    return { ...base, available: false, error: "Quote returned zero output", errorCode: "ZERO_OUTPUT" };
  }
  return { ...base, available: true, tokensOut, slippage: result.data.slippage };
}

function enrichQuote(quote, listing, usdtAmount, reference) {
  const oracle = reference.oracleByIssuer[listing.issuer];
  const multiplier = oracle?.multiplier ?? listing.multiplier;
  const multiplierSource = oracle?.multiplier ? "dynamic" : "list";
  const enriched = { ...quote, multiplier, multiplierSource, oraclePricePerShare: oracle?.oraclePricePerShare ?? null };
  if (!quote.available) {
    return { ...enriched, toxic: false, suspect: false, premiumBps: null };
  }
  const sharesOut = quote.tokensOut * multiplier;
  const pricePerShare = usdtAmount / sharesOut;
  const premiumBps = reference.referencePrice ? ((pricePerShare - reference.referencePrice) / reference.referencePrice) * 10000 : null;
  return {
    ...enriched,
    sharesOut,
    pricePerShare,
    naivePricePerToken: usdtAmount / quote.tokensOut,
    premiumBps,
    toxic: premiumBps !== null && premiumBps > TOXIC_PREMIUM_BPS,
    suspect: premiumBps !== null && premiumBps < -SUSPECT_DISCOUNT_BPS
  };
}

export async function quoteTicker(ticker, usdtAmount) {
  const symbol = ticker.toUpperCase();
  const listings = await getListings(symbol);
  const quotedAt = new Date().toISOString();
  if (listings.length === 0) {
    return { ticker: symbol, usdtAmount, quotedAt, quotes: [], available: [], best: null, worst: null, toxic: [], suspect: [], error: "Ticker not found on BSC" };
  }
  const [reference, rawQuotes] = await Promise.all([
    getReference(listings),
    Promise.all(listings.map((listing) => rawQuote(listing, usdtAmount)))
  ]);
  const quotes = rawQuotes.map((quote, index) => enrichQuote(quote, listings[index], usdtAmount, reference));
  const live = quotes.filter((quote) => quote.available);
  const toxic = live.filter((quote) => quote.toxic);
  const suspect = live.filter((quote) => quote.suspect);
  const safe = live.filter((quote) => !quote.toxic && !quote.suspect).sort((a, b) => b.sharesOut - a.sharesOut);
  const best = safe[0] ?? null;
  const worst = safe.length > 1 ? safe[safe.length - 1] : null;
  const naiveBest = [...safe].sort((a, b) => b.tokensOut - a.tokensOut)[0] ?? null;
  const summary = {
    ticker: symbol,
    usdtAmount,
    quotedAt,
    reference: {
      price: reference.referencePrice,
      source: reference.referenceSource,
      usStockPrice: reference.usStockPrice,
      oracleMedian: reference.oracleMedian,
      marketStatus: reference.marketStatus
    },
    quotes,
    available: safe,
    toxic,
    suspect,
    best,
    worst,
    issuersListed: listings.length,
    issuersLive: live.length,
    issuersSafe: safe.length,
    spreadBps: null,
    savingsUsd: null,
    bestVsReferenceBps: best?.premiumBps ?? null,
    maxLossAvoidedUsd: null,
    multiplierFlipsWinner: Boolean(best && naiveBest && best.issuer !== naiveBest.issuer)
  };
  if (best && worst) {
    summary.spreadBps = ((worst.pricePerShare - best.pricePerShare) / best.pricePerShare) * 10000;
    summary.savingsUsd = usdtAmount * (1 - worst.sharesOut / best.sharesOut);
  }
  if (best && toxic.length > 0) {
    const lowestToxicShares = Math.min(...toxic.map((quote) => quote.sharesOut));
    summary.maxLossAvoidedUsd = usdtAmount * (1 - lowestToxicShares / best.sharesOut);
  }
  return summary;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function resolveScanTickers({ tickers, all = false } = {}) {
  if (tickers && tickers.length > 0) {
    return tickers.map((ticker) => ticker.toUpperCase());
  }
  if (all) {
    const multi = await getMultiIssuerTickers(2);
    return multi.map((entry) => entry.ticker);
  }
  return DEFAULT_WATCHLIST;
}

export async function scan({ tickers, all = false, usdtAmount = 5, concurrency = DEFAULT_CONCURRENCY, onProgress = () => {} } = {}) {
  const scanTickers = await resolveScanTickers({ tickers, all });
  let completed = 0;
  const rows = await mapWithConcurrency(scanTickers, concurrency, async (ticker) => {
    const row = await quoteTicker(ticker, usdtAmount);
    completed += 1;
    onProgress({ completed, total: scanTickers.length, row });
    return row;
  });
  const flagged = (row) => (row.toxic?.length ?? 0) + (row.suspect?.length ?? 0);
  return rows.sort((a, b) => flagged(b) - flagged(a) || (b.spreadBps ?? -1) - (a.spreadBps ?? -1));
}
