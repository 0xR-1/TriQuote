import { getListings, getMultiIssuerTickers, USDT_BSC } from "./registry.js";
import { quoteSwap } from "./baw.js";
import { getReference } from "./reference.js";

export const DEFAULT_WATCHLIST = ["NVDA", "TSLA", "AAPL", "MSFT", "META", "GOOGL", "AMZN", "SPY", "QQQ", "COIN"];
export const TOXIC_PREMIUM_BPS = 300;
export const SUSPECT_DISCOUNT_BPS = 500;
export const PEER_OUTLIER_BPS = 500;
export const EXTREME_DEVIATION_BPS = 2000;
export const MULTIPLIER_MISMATCH_BPS = 50;
export const MIN_PEERS_FOR_CONSENSUS = 3;
export const GRADES = { SAFE: "SAFE", CAUTION: "CAUTION", TOXIC: "TOXIC" };
const DEFAULT_CONCURRENCY = 3;

export const toBps = (value, base) => (Number.isFinite(value) && Number.isFinite(base) && base > 0 ? ((value - base) / base) * 10000 : null);

export function median(values) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) {
    return null;
  }
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

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

export function enrichQuote(quote, listing, usdtAmount, reference) {
  const oracle = reference.oracleByIssuer?.[listing.issuer];
  const multiplier = oracle?.multiplier ?? listing.multiplier;
  const multiplierSource = oracle?.multiplier ? "dynamic" : "list";
  const registryMultiplier = listing.multiplier;
  const multiplierDriftBps = oracle?.multiplier ? Math.abs(toBps(oracle.multiplier, registryMultiplier) ?? 0) : 0;
  const enriched = {
    ...quote,
    multiplier,
    multiplierSource,
    registryMultiplier,
    multiplierDriftBps,
    oraclePricePerShare: oracle?.oraclePricePerShare ?? null
  };
  if (!quote.available) {
    return { ...enriched, premiumBps: null };
  }
  const sharesOut = quote.tokensOut * multiplier;
  const pricePerShare = usdtAmount / sharesOut;
  return {
    ...enriched,
    sharesOut,
    pricePerShare,
    naivePricePerToken: usdtAmount / quote.tokensOut,
    premiumBps: toBps(pricePerShare, reference.referencePrice)
  };
}

export function assessQuotes(quotes, reference) {
  const live = quotes.filter((quote) => quote.available);
  const peerBaseline = live.length >= MIN_PEERS_FOR_CONSENSUS ? median(live.map((quote) => quote.pricePerShare)) : null;
  return quotes.map((quote) => {
    if (!quote.available) {
      return { ...quote, grade: null, reasons: [], signals: null, toxic: false, suspect: false, caution: false };
    }
    const signals = {
      referenceBps: quote.premiumBps,
      oracleBps: toBps(quote.pricePerShare, reference.oracleMedian),
      peerBps: peerBaseline === null ? null : toBps(quote.pricePerShare, peerBaseline),
      multiplierDriftBps: quote.multiplierDriftBps ?? 0
    };
    const reasons = [];
    if (signals.referenceBps !== null && signals.referenceBps > TOXIC_PREMIUM_BPS) {
      reasons.push("REF_PREMIUM");
    }
    if (signals.referenceBps !== null && signals.referenceBps < -SUSPECT_DISCOUNT_BPS) {
      reasons.push("REF_DISCOUNT");
    }
    if (signals.oracleBps !== null && Math.abs(signals.oracleBps) > TOXIC_PREMIUM_BPS) {
      reasons.push("ORACLE_DEVIATION");
    }
    if (signals.peerBps !== null && Math.abs(signals.peerBps) > PEER_OUTLIER_BPS) {
      reasons.push("PEER_OUTLIER");
    }
    if (signals.multiplierDriftBps > MULTIPLIER_MISMATCH_BPS) {
      reasons.push("MULTIPLIER_MISMATCH");
    }
    const priceSignals = [signals.referenceBps, signals.oracleBps, signals.peerBps].filter((value) => value !== null).map(Math.abs);
    const extreme = priceSignals.length > 0 && Math.max(...priceSignals) > EXTREME_DEVIATION_BPS;
    const grade = extreme || reasons.length >= 2 ? GRADES.TOXIC : reasons.length === 1 ? GRADES.CAUTION : GRADES.SAFE;
    const direction = signals.referenceBps ?? signals.peerBps ?? signals.oracleBps ?? 0;
    return {
      ...quote,
      grade,
      reasons,
      signals,
      toxic: grade === GRADES.TOXIC && direction >= 0,
      suspect: grade === GRADES.TOXIC && direction < 0,
      caution: grade === GRADES.CAUTION
    };
  });
}

export function summarizeRoutes({ ticker, usdtAmount, quotedAt, listingsCount, reference, quotes, allowCaution = false }) {
  const live = quotes.filter((quote) => quote.available);
  const toxic = live.filter((quote) => quote.toxic);
  const suspect = live.filter((quote) => quote.suspect);
  const caution = live.filter((quote) => quote.caution);
  const routable = live.filter((quote) => quote.grade === GRADES.SAFE || (allowCaution && quote.grade === GRADES.CAUTION));
  const safe = [...routable].sort((a, b) => b.sharesOut - a.sharesOut);
  const best = safe[0] ?? null;
  const worst = safe.length > 1 ? safe[safe.length - 1] : null;
  const naiveBest = [...safe].sort((a, b) => b.tokensOut - a.tokensOut)[0] ?? null;
  const summary = {
    ticker,
    usdtAmount,
    quotedAt,
    allowCaution,
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
    caution,
    best,
    worst,
    issuersListed: listingsCount,
    issuersLive: live.length,
    issuersSafe: safe.length,
    spreadBps: null,
    savingsUsd: null,
    bestVsReferenceBps: best?.premiumBps ?? null,
    maxLossAvoidedUsd: null,
    multiplierFlipsWinner: Boolean(best && naiveBest && best.issuer !== naiveBest.issuer)
  };
  if (best && worst) {
    summary.spreadBps = toBps(worst.pricePerShare, best.pricePerShare);
    summary.savingsUsd = usdtAmount * (1 - worst.sharesOut / best.sharesOut);
  }
  if (best && toxic.length > 0) {
    const lowestToxicShares = Math.min(...toxic.map((quote) => quote.sharesOut));
    summary.maxLossAvoidedUsd = usdtAmount * (1 - lowestToxicShares / best.sharesOut);
  }
  return summary;
}

export async function quoteTicker(ticker, usdtAmount, { allowCaution = false } = {}) {
  const symbol = ticker.toUpperCase();
  const listings = await getListings(symbol);
  const quotedAt = new Date().toISOString();
  if (listings.length === 0) {
    return {
      ticker: symbol,
      usdtAmount,
      quotedAt,
      quotes: [],
      available: [],
      best: null,
      worst: null,
      toxic: [],
      suspect: [],
      caution: [],
      spreadBps: null,
      savingsUsd: null,
      bestVsReferenceBps: null,
      maxLossAvoidedUsd: null,
      error: "Ticker not found on BSC"
    };
  }
  const [reference, rawQuotes] = await Promise.all([
    getReference(listings),
    Promise.all(listings.map((listing) => rawQuote(listing, usdtAmount)))
  ]);
  const enriched = rawQuotes.map((quote, index) => enrichQuote(quote, listings[index], usdtAmount, reference));
  return summarizeRoutes({
    ticker: symbol,
    usdtAmount,
    quotedAt,
    listingsCount: listings.length,
    reference,
    quotes: assessQuotes(enriched, reference),
    allowCaution
  });
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

export async function scan({ tickers, all = false, usdtAmount = 5, allowCaution = false, concurrency = DEFAULT_CONCURRENCY, onProgress = () => {} } = {}) {
  const scanTickers = await resolveScanTickers({ tickers, all });
  let completed = 0;
  const rows = await mapWithConcurrency(scanTickers, concurrency, async (ticker) => {
    const row = await quoteTicker(ticker, usdtAmount, { allowCaution });
    completed += 1;
    onProgress({ completed, total: scanTickers.length, row });
    return row;
  });
  const flagged = (row) => (row.toxic?.length ?? 0) + (row.suspect?.length ?? 0) + (row.caution?.length ?? 0);
  return rows.sort((a, b) => flagged(b) - flagged(a) || (b.spreadBps ?? -1) - (a.spreadBps ?? -1));
}
