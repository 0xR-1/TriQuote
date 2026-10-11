#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteTicker, scan, TOXIC_PREMIUM_BPS, SUSPECT_DISCOUNT_BPS, PEER_OUTLIER_BPS, MULTIPLIER_MISMATCH_BPS } from "./router.js";
import { submitSwap, tokenBalance, waitForTerminalOrder, walletStatus } from "./baw.js";
import { USDT_BSC } from "./registry.js";

const MAX_TRADE_USDT = 5;
export const DEFAULT_SLIPPAGE_PERCENT = 1;
export const MAX_SLIPPAGE_PERCENT = 5;
const BALANCE_POLL_ATTEMPTS = 6;
const BALANCE_POLL_INTERVAL_MS = 3000;
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TRADE_LOG_FILE = join(PROJECT_ROOT, ".cache", "trades.jsonl");

const color = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  dim: (text) => `\x1b[2m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        index++;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

const usd = (value, digits = 2) => (value === null || value === undefined ? "-" : `$${Number(value).toFixed(digits)}`);
const bps = (value) => (value === null || value === undefined ? "-" : `${value.toFixed(1)} bps`);
const signedBps = (value) => (value === null || value === undefined ? "-" : `${value >= 0 ? "+" : ""}${value.toFixed(0)} bps`);

function describeReference(reference) {
  if (!reference || !reference.price) {
    return "no reference price";
  }
  const source = reference.source === "us-stock-last" ? "US last price" : "oracle median";
  const market = reference.marketStatus ? ` · market ${reference.marketStatus}` : "";
  return `ref ${usd(reference.price, 2)} (${source})${market}`;
}

function printTickerSummary(summary) {
  console.log(color.bold(`\n${summary.ticker}  ·  ${summary.usdtAmount} USDT  ·  ${summary.issuersSafe ?? 0} safe / ${summary.issuersLive ?? 0} live / ${summary.issuersListed ?? 0} listed`));
  if (summary.error) {
    console.log(color.red(`  ${summary.error}`));
    return;
  }
  console.log(color.cyan(`  ${describeReference(summary.reference)}`));
  for (const quote of summary.quotes) {
    const isBest = summary.best && quote.issuer === summary.best.issuer;
    const label = `${quote.issuerName.padEnd(8)} ${quote.symbol.padEnd(10)}`;
    if (!quote.available) {
      console.log(color.dim(`  ✗ ${label} unavailable: ${quote.error}`));
      continue;
    }
    const core = `${label} ${usd(quote.pricePerShare, 4).padStart(12)} /share  ${signedBps(quote.premiumBps).padStart(11)} vs ref   x${quote.multiplier.toFixed(6)}   ${quote.latencyMs}ms`;
    const why = quote.reasons?.length ? ` [${quote.reasons.join(", ")}]` : "";
    if (quote.toxic) {
      const loss = summary.best ? summary.usdtAmount * (1 - quote.sharesOut / summary.best.sharesOut) : null;
      console.log(color.red(`  ☠ ${core}   TOXIC${loss !== null ? ` · would lose ${usd(loss, 2)}` : ""}${why}`));
      continue;
    }
    if (quote.suspect) {
      console.log(color.yellow(`  ⚠ ${core}   SUSPECT · too cheap vs reference, not routed${why}`));
      continue;
    }
    if (quote.caution && !isBest) {
      console.log(color.yellow(`  ? ${core}   CAUTION · not routed without --allow-caution${why}`));
      continue;
    }
    console.log(isBest ? color.green(`  ★ ${core}${why}`) : `  · ${core}`);
  }
  if (summary.spreadBps !== null) {
    console.log(`  spread ${color.yellow(bps(summary.spreadBps))} between safe issuers · best vs worst saves ${color.green(usd(summary.savingsUsd, 4))}`);
  }
  if (summary.bestVsReferenceBps !== null && summary.bestVsReferenceBps < 0) {
    console.log(color.green(`  best route is ${Math.abs(summary.bestVsReferenceBps).toFixed(0)} bps BELOW the reference price`));
  }
  if (summary.maxLossAvoidedUsd !== null) {
    console.log(color.red(`  blocked ${summary.toxic.length} toxic quote(s) priced >${TOXIC_PREMIUM_BPS} bps over reference · avoided losing up to ${usd(summary.maxLossAvoidedUsd, 2)}`));
  }
  if (summary.caution?.length > 0 && !summary.allowCaution) {
    console.log(color.yellow(`  ${summary.caution.length} quote(s) carry one warning signal and were left out; pass --allow-caution to include them`));
  }
  if (summary.suspect?.length > 0) {
    console.log(color.yellow(`  held back ${summary.suspect.length} suspect quote(s) priced >${SUSPECT_DISCOUNT_BPS} bps under reference (likely bad data, not a bargain)`));
  }
  if (summary.multiplierFlipsWinner) {
    console.log(color.yellow("  ! raw token amounts point to a different issuer; share multipliers change the winner"));
  }
}

function flagLabel(row) {
  const toxic = (row.toxic ?? []).map((quote) => `☠ ${quote.symbol}`);
  const suspect = (row.suspect ?? []).map((quote) => `⚠ ${quote.symbol}`);
  const caution = (row.caution ?? []).map((quote) => `? ${quote.symbol}`);
  const labels = [...toxic, ...suspect, ...caution];
  return labels.length > 0 ? labels.join(" ") : "-";
}

function printScanTable(rows) {
  console.log(color.bold("\nTICKER  SAFE  BEST                 BEST $/SHARE    VS REF      SPREAD   FLAGS"));
  for (const row of rows) {
    const safe = `${row.issuersSafe ?? 0}/${row.issuersListed ?? 0}`;
    const best = row.best ? `${row.best.issuerName} ${row.best.symbol}` : "none";
    const line = `${row.ticker.padEnd(7)} ${safe.padEnd(5)} ${best.padEnd(20)} ${usd(row.best?.pricePerShare, 4).padStart(13)}  ${signedBps(row.bestVsReferenceBps).padStart(9)}  ${bps(row.spreadBps).padStart(10)}   ${flagLabel(row)}`;
    if ((row.toxic?.length ?? 0) > 0) {
      console.log(color.red(line));
    } else if ((row.suspect?.length ?? 0) > 0 || (row.caution?.length ?? 0) > 0 || (row.spreadBps !== null && row.spreadBps >= 30)) {
      console.log(color.yellow(line));
    } else {
      console.log(line);
    }
  }
  const toxicTotal = rows.reduce((total, row) => total + (row.toxic?.length ?? 0), 0);
  const suspectTotal = rows.reduce((total, row) => total + (row.suspect?.length ?? 0), 0);
  const cautionTotal = rows.reduce((total, row) => total + (row.caution?.length ?? 0), 0);
  if (toxicTotal > 0 || suspectTotal > 0 || cautionTotal > 0) {
    console.log(color.red(`\n${toxicTotal} toxic, ${suspectTotal} suspect and ${cautionTotal} caution quote(s) kept out of routing across ${rows.length} tickers`));
  }
}

export function buildScanPayload(rows, usdtAmount, startedAt) {
  return {
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    usdtAmount,
    toxicThresholdBps: TOXIC_PREMIUM_BPS,
    suspectThresholdBps: SUSPECT_DISCOUNT_BPS,
    peerOutlierBps: PEER_OUTLIER_BPS,
    multiplierMismatchBps: MULTIPLIER_MISMATCH_BPS,
    rows
  };
}

async function commandScan(positional, flags) {
  const usdtAmount = Number(flags.usdt ?? 5);
  const startedAt = Date.now();
  const rows = await scan({
    tickers: positional,
    all: Boolean(flags.all),
    usdtAmount,
    allowCaution: Boolean(flags["allow-caution"]),
    onProgress: ({ completed, total, row }) => {
      if (!flags.json) {
        process.stderr.write(color.dim(`  [${completed}/${total}] ${row.ticker}\n`));
      }
    }
  });
  if (typeof flags.save === "string") {
    const target = resolve(flags.save);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(buildScanPayload(rows, usdtAmount, startedAt), null, 2)}\n`);
    process.stderr.write(color.green(`  saved scan snapshot to ${target}\n`));
  }
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  printScanTable(rows);
}

async function commandBest(positional, flags) {
  const ticker = positional[0];
  if (!ticker) {
    throw new Error("Usage: node src/cli.js best <TICKER> [--usdt 5]");
  }
  const summary = await quoteTicker(ticker, Number(flags.usdt ?? 5), { allowCaution: Boolean(flags["allow-caution"]) });
  if (flags.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printTickerSummary(summary);
}

async function logTrade(entry) {
  await mkdir(dirname(TRADE_LOG_FILE), { recursive: true });
  await appendFile(TRADE_LOG_FILE, `${JSON.stringify(entry)}\n`);
}

async function measureFill(route, usdtAmount, balanceBefore, referencePrice) {
  if (balanceBefore === null) {
    return { verified: false, reason: "balance before the swap could not be read" };
  }
  for (let attempt = 0; attempt < BALANCE_POLL_ATTEMPTS; attempt++) {
    const after = await tokenBalance(route.address);
    if (after.success && after.balance > balanceBefore) {
      const receivedTokens = after.balance - balanceBefore;
      const actualPricePerShare = usdtAmount / (receivedTokens * route.multiplier);
      return {
        verified: true,
        receivedTokens,
        actualPricePerShare,
        executionVsQuoteBps: ((actualPricePerShare - route.pricePerShare) / route.pricePerShare) * 10000,
        actualVsReferenceBps: referencePrice ? ((actualPricePerShare - referencePrice) / referencePrice) * 10000 : null
      };
    }
    await sleep(BALANCE_POLL_INTERVAL_MS);
  }
  return { verified: false, reason: "token balance did not increase within the polling window" };
}

export function resolveSlippage(value) {
  if (value === undefined || value === true) {
    return DEFAULT_SLIPPAGE_PERCENT;
  }
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent <= 0 || percent > MAX_SLIPPAGE_PERCENT) {
    throw new Error(`--slippage must be a percentage above 0 and at most ${MAX_SLIPPAGE_PERCENT}`);
  }
  return percent;
}

async function commandBuy(positional, flags) {
  const ticker = positional[0];
  const usdtAmount = Number(flags.usdt);
  if (!ticker || !(usdtAmount > 0)) {
    throw new Error("Usage: node src/cli.js buy <TICKER> --usdt <amount> [--confirm] [--slippage 1]");
  }
  if (usdtAmount > MAX_TRADE_USDT) {
    throw new Error(`Refusing to trade ${usdtAmount} USDT: TriQuote caps every live trade at ${MAX_TRADE_USDT} USDT`);
  }
  const slippage = resolveSlippage(flags.slippage);
  const status = await walletStatus();
  if (!status.success || status.data?.status !== "CONNECTED") {
    throw new Error("Agentic Wallet is not connected. Run: baw auth signin --json");
  }
  const summary = await quoteTicker(ticker, usdtAmount, { allowCaution: Boolean(flags["allow-caution"]) });
  printTickerSummary(summary);
  if (!summary.best) {
    const flagged = (summary.toxic?.length ?? 0) + (summary.suspect?.length ?? 0) + (summary.caution?.length ?? 0);
    const reason = flagged > 0 ? "every live quote is toxic, suspect or caution" : "no issuer has live liquidity";
    throw new Error(`Refusing to route ${summary.ticker}: ${reason} right now`);
  }
  const route = summary.best;
  console.log(color.bold(`\nRoute: ${usdtAmount} USDT → ${route.symbol} (${route.issuerName}) at ~${usd(route.pricePerShare, 4)}/share (${signedBps(route.premiumBps)} vs ref) · max slippage ${slippage}%`));
  if (!flags.confirm) {
    console.log(color.yellow("Dry run only. Re-run with --confirm to execute this swap on BSC mainnet."));
    return;
  }
  const before = await tokenBalance(route.address);
  const balanceBefore = before.success ? before.balance : null;
  const submitted = await submitSwap({
    fromToken: USDT_BSC,
    toToken: route.address,
    fromTokenQty: usdtAmount,
    slippage
  });
  if (!submitted.success || !submitted.data?.orderId) {
    await logTrade({ at: new Date().toISOString(), ticker: summary.ticker, usdtAmount, route: route.symbol, issuer: route.issuer, status: "REJECTED", error: submitted.error ?? null });
    throw new Error(`Swap was not submitted: ${submitted.error?.message ?? "unknown error"}`);
  }
  const orderId = submitted.data.orderId;
  console.log(`Submitted order ${orderId}. Waiting for an on-chain terminal state...`);
  const outcome = await waitForTerminalOrder(orderId, (order) => {
    process.stderr.write(color.dim(`  status ${order.status}\n`));
  });
  const order = outcome.order;
  const fill = outcome.terminal && order.status === "FINISHED"
    ? await measureFill(route, usdtAmount, balanceBefore, summary.reference?.price ?? null)
    : { verified: false, reason: "order did not finish" };
  await logTrade({
    at: new Date().toISOString(),
    ticker: summary.ticker,
    usdtAmount,
    route: route.symbol,
    issuer: route.issuer,
    quotedPricePerShare: route.pricePerShare,
    referencePrice: summary.reference?.price ?? null,
    premiumBps: route.premiumBps,
    slippagePercent: slippage,
    spreadBps: summary.spreadBps,
    savingsUsd: summary.savingsUsd,
    toxicBlocked: summary.toxic.map((quote) => quote.symbol),
    suspectHeld: (summary.suspect ?? []).map((quote) => quote.symbol),
    routeGrade: route.grade,
    routeReasons: route.reasons ?? [],
    lossAvoidedUsd: summary.maxLossAvoidedUsd,
    fillVerified: fill.verified,
    receivedTokens: fill.receivedTokens ?? null,
    actualPricePerShare: fill.actualPricePerShare ?? null,
    executionVsQuoteBps: fill.executionVsQuoteBps ?? null,
    actualVsReferenceBps: fill.actualVsReferenceBps ?? null,
    orderId,
    status: order?.status ?? "UNKNOWN",
    txHash: order?.txHash ?? null
  });
  if (!outcome.terminal) {
    console.log(color.yellow(`Order ${orderId} is still processing. Check later with: baw market-order list --orderId ${orderId} --json`));
    return;
  }
  if (order.status === "FINISHED") {
    console.log(color.green(`FINISHED  tx https://bscscan.com/tx/${order.txHash}`));
    if (fill.verified) {
      console.log(color.green(`Filled ${fill.receivedTokens} ${route.symbol} → ${usd(fill.actualPricePerShare, 4)}/share · ${signedBps(fill.executionVsQuoteBps)} vs quote · ${signedBps(fill.actualVsReferenceBps)} vs ref`));
    } else {
      console.log(color.yellow(`Fill not verified: ${fill.reason}`));
    }
    return;
  }
  console.log(color.red(`FAILED  order ${orderId}${order.txHash ? ` tx https://bscscan.com/tx/${order.txHash}` : " (no tx hash)"}`));
  process.exitCode = 1;
}

const COMMANDS = { scan: commandScan, best: commandBest, buy: commandBuy };

async function main() {
  const [commandName, ...rest] = process.argv.slice(2);
  const command = COMMANDS[commandName];
  if (!command) {
    console.log("Usage:\n  node src/cli.js scan [TICKERS...] [--all] [--usdt 5] [--allow-caution] [--json] [--save snapshots/scan.json]\n  node src/cli.js best <TICKER> [--usdt 5] [--allow-caution] [--json]\n  node src/cli.js buy <TICKER> --usdt <amount<=5> [--allow-caution] [--confirm] [--slippage 1]");
    process.exitCode = commandName ? 1 : 0;
    return;
  }
  const { positional, flags } = parseArgs(rest);
  await command(positional, flags);
}

function resolveEntrypoint(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const isEntrypoint = Boolean(process.argv[1]) && resolveEntrypoint(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntrypoint) {
  main().catch((error) => {
    console.error(color.red(`Error: ${error.message}`));
    process.exitCode = 1;
  });
}
