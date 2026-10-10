import { test } from "node:test";
import assert from "node:assert/strict";
import { assessQuotes, enrichQuote, median, summarizeRoutes, toBps, GRADES } from "../src/router.js";

const USDT = 5;

function listing(issuer, symbol, multiplier) {
  const names = { ondo: "Ondo", xstocks: "xStocks", bstocks: "bStocks" };
  return { ticker: symbol.replace(/(on|x|B)$/, ""), issuer, issuerName: names[issuer], symbol, address: `0x${symbol}`, multiplier };
}

function liveQuote(item, tokensOut) {
  return { issuer: item.issuer, issuerName: item.issuerName, symbol: item.symbol, address: item.address, latencyMs: 1, available: true, tokensOut, slippage: 0.01 };
}

function deadQuote(item) {
  return { issuer: item.issuer, issuerName: item.issuerName, symbol: item.symbol, address: item.address, latencyMs: 1, available: false, error: "No liquidity available, please try again later." };
}

function tokensFor(pricePerShare, multiplier) {
  return USDT / (pricePerShare * multiplier);
}

function route({ ticker, listings, reference, rawQuotes, allowCaution = false }) {
  const enriched = rawQuotes.map((quote, index) => enrichQuote(quote, listings[index], USDT, reference));
  return summarizeRoutes({
    ticker,
    usdtAmount: USDT,
    quotedAt: "2026-10-10T19:22:20.000Z",
    listingsCount: listings.length,
    reference,
    quotes: assessQuotes(enriched, reference),
    allowCaution
  });
}

const spyListings = [listing("ondo", "SPYon", 1.009473), listing("xstocks", "SPYx", 1), listing("bstocks", "SPYB", 1.00173)];
const spyReference = {
  referencePrice: 779.77,
  referenceSource: "us-stock-last",
  usStockPrice: 779.77,
  oracleMedian: 779.42,
  marketStatus: "offhours",
  oracleByIssuer: {
    ondo: { multiplier: 1.009473, oraclePricePerShare: 779.83 },
    xstocks: { multiplier: 1.005715, oraclePricePerShare: 767.19 },
    bstocks: { multiplier: 1.00173, oraclePricePerShare: 779.42 }
  }
};

function spyLive() {
  return route({
    ticker: "SPY",
    listings: spyListings,
    reference: spyReference,
    rawQuotes: [
      liveQuote(spyListings[0], tokensFor(774.0002, 1.009473)),
      liveQuote(spyListings[1], tokensFor(8912.4592, 1.005715)),
      liveQuote(spyListings[2], tokensFor(777.8752, 1.00173))
    ]
  });
}

test("toBps and median", () => {
  assert.equal(toBps(101, 100), 100);
  assert.equal(toBps(1, 0), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("live SPYx quote from 10 Oct 2026 is toxic for several independent reasons", () => {
  const summary = spyLive();
  const spyx = summary.quotes.find((quote) => quote.symbol === "SPYx");
  assert.equal(spyx.grade, GRADES.TOXIC);
  assert.equal(spyx.toxic, true);
  for (const reason of ["REF_PREMIUM", "ORACLE_DEVIATION", "PEER_OUTLIER", "MULTIPLIER_MISMATCH"]) {
    assert.ok(spyx.reasons.includes(reason), `missing ${reason}`);
  }
  assert.deepEqual(summary.toxic.map((quote) => quote.symbol), ["SPYx"]);
});

test("SPY routes to Ondo and records the loss the shield avoided", () => {
  const summary = spyLive();
  assert.equal(summary.best.symbol, "SPYon");
  assert.equal(summary.issuersSafe, 2);
  assert.ok(Math.abs(summary.maxLossAvoidedUsd - 4.57) < 0.01, `loss avoided was ${summary.maxLossAvoidedUsd}`);
  assert.ok(summary.bestVsReferenceBps < -70 && summary.bestVsReferenceBps > -80);
  assert.ok(summary.spreadBps > 45 && summary.spreadBps < 55);
});

test("share multipliers flip the winner on SPY", () => {
  const summary = spyLive();
  const safe = summary.quotes.filter((quote) => quote.grade === GRADES.SAFE);
  const mostTokens = [...safe].sort((a, b) => b.tokensOut - a.tokensOut)[0];
  assert.equal(mostTokens.symbol, "SPYB");
  assert.equal(summary.best.symbol, "SPYon");
  assert.equal(summary.multiplierFlipsWinner, true);
});

test("a suspiciously cheap quote is held back instead of being picked as best", () => {
  const items = [listing("ondo", "NVDAon", 1), listing("xstocks", "NVDAx", 1), listing("bstocks", "NVDAB", 1)];
  const reference = { referencePrice: 230, referenceSource: "us-stock-last", usStockPrice: 230, oracleMedian: 230, marketStatus: "offhours", oracleByIssuer: {} };
  const summary = route({
    ticker: "NVDA",
    listings: items,
    reference,
    rawQuotes: [liveQuote(items[0], tokensFor(230.3, 1)), liveQuote(items[1], tokensFor(231.1, 1)), liveQuote(items[2], tokensFor(120, 1))]
  });
  const cheap = summary.quotes.find((quote) => quote.symbol === "NVDAB");
  assert.equal(cheap.grade, GRADES.TOXIC);
  assert.equal(cheap.suspect, true);
  assert.equal(cheap.toxic, false);
  assert.equal(summary.best.symbol, "NVDAon");
});

test("one weak signal is CAUTION: excluded by default, routable when allowed", () => {
  const items = [listing("ondo", "MSFTon", 1), listing("bstocks", "MSFTB", 1)];
  const reference = {
    referencePrice: 534,
    referenceSource: "us-stock-last",
    usStockPrice: 534,
    oracleMedian: 534,
    marketStatus: "offhours",
    oracleByIssuer: { ondo: { multiplier: 1.01, oraclePricePerShare: 534 } }
  };
  const rawQuotes = [liveQuote(items[0], tokensFor(531, 1.01)), liveQuote(items[1], tokensFor(534.5, 1))];
  const strict = route({ ticker: "MSFT", listings: items, reference, rawQuotes });
  const ondo = strict.quotes.find((quote) => quote.symbol === "MSFTon");
  assert.equal(ondo.grade, GRADES.CAUTION);
  assert.deepEqual(ondo.reasons, ["MULTIPLIER_MISMATCH"]);
  assert.equal(strict.best.symbol, "MSFTB");
  const relaxed = route({ ticker: "MSFT", listings: items, reference, rawQuotes, allowCaution: true });
  assert.equal(relaxed.best.symbol, "MSFTon");
});

test("with only two live issuers the peer signal abstains instead of guessing", () => {
  const items = [listing("ondo", "COINon", 1), listing("bstocks", "COINB", 1)];
  const reference = { referencePrice: 181, referenceSource: "us-stock-last", usStockPrice: 181, oracleMedian: 181, marketStatus: "offhours", oracleByIssuer: {} };
  const summary = route({
    ticker: "COIN",
    listings: items,
    reference,
    rawQuotes: [liveQuote(items[0], tokensFor(181.6, 1)), liveQuote(items[1], tokensFor(180.9, 1))]
  });
  for (const quote of summary.quotes) {
    assert.equal(quote.signals.peerBps, null);
    assert.equal(quote.grade, GRADES.SAFE);
  }
  assert.equal(summary.best.symbol, "COINB");
});

test("unavailable issuers are reported but never graded or routed", () => {
  const items = [listing("ondo", "TSLAon", 1), listing("xstocks", "TSLAx", 1)];
  const reference = { referencePrice: 383, referenceSource: "us-stock-last", usStockPrice: 383, oracleMedian: 383, marketStatus: "offhours", oracleByIssuer: {} };
  const summary = route({ ticker: "TSLA", listings: items, reference, rawQuotes: [liveQuote(items[0], tokensFor(383.6, 1)), deadQuote(items[1])] });
  const dead = summary.quotes.find((quote) => quote.symbol === "TSLAx");
  assert.equal(dead.grade, null);
  assert.equal(summary.issuersLive, 1);
  assert.equal(summary.best.symbol, "TSLAon");
  assert.equal(summary.spreadBps, null);
});
