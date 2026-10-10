#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteTicker, scan, TOXIC_PREMIUM_BPS } from "./router.js";
import { submitSwap, waitForTerminalOrder, walletStatus } from "./baw.js";
import { USDT_BSC } from "./registry.js";

const MAX_TRADE_USDT = 5;
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
    if (quote.toxic) {
      const loss = summary.best ? summary.usdtAmount * (1 - quote.sharesOut / summary.best.sharesOut) : null;
      console.log(color.red(`  ☠ ${core}   TOXIC${loss !== null ? ` · would lose ${usd(loss, 2)}` : ""}`));
      continue;
    }
    console.log(isBest ? color.green(`  ★ ${core}`) : `  · ${core}`);
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
  if (summary.multiplierFlipsWinner) {
    console.log(color.yellow("  ! raw token amounts point to a different issuer; share multipliers change the winner"));
  }
}

function printScanTable(rows) {
  console.log(color.bold("\nTICKER  SAFE  BEST                 BEST $/SHARE    VS REF      SPREAD   TOXIC"));
  for (const row of rows) {
    const safe = `${row.issuersSafe ?? 0}/${row.issuersListed ?? 0}`;
    const best = row.best ? `${row.best.issuerName} ${row.best.symbol}` : "none";
    const toxicCount = row.toxic?.length ?? 0;
    const toxicLabel = toxicCount > 0 ? `☠ ${row.toxic.map((quote) => quote.symbol).join(",")}` : "-";
    const line = `${row.ticker.padEnd(7)} ${safe.padEnd(5)} ${best.padEnd(20)} ${usd(row.best?.pricePerShare, 4).padStart(13)}  ${signedBps(row.bestVsReferenceBps).padStart(9)}  ${bps(row.spreadBps).padStart(10)}   ${toxicLabel}`;
    if (toxicCount > 0) {
      console.log(color.red(line));
    } else if (row.spreadBps !== null && row.spreadBps >= 30) {
      console.log(color.yellow(line));
    } else {
      console.log(line);
    }
  }
  const toxicTotal = rows.reduce((total, row) => total + (row.toxic?.length ?? 0), 0);
  if (toxicTotal > 0) {
    console.log(color.red(`\n${toxicTotal} toxic quote(s) blocked across ${rows.length} tickers`));
  }
}

async function commandScan(positional, flags) {
  const usdtAmount = Number(flags.usdt ?? 5);
  const rows = await scan({
    tickers: positional,
    all: Boolean(flags.all),
    usdtAmount,
    onProgress: ({ completed, total, row }) => {
      if (!flags.json) {
        process.stderr.write(color.dim(`  [${completed}/${total}] ${row.ticker}\n`));
      }
    }
  });
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
  const summary = await quoteTicker(ticker, Number(flags.usdt ?? 5));
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

async function commandBuy(positional, flags) {
  const ticker = positional[0];
  const usdtAmount = Number(flags.usdt);
  if (!ticker || !(usdtAmount > 0)) {
    throw new Error("Usage: node src/cli.js buy <TICKER> --usdt <amount> [--confirm] [--slippage 1]");
  }
  if (usdtAmount > MAX_TRADE_USDT) {
    throw new Error(`Refusing to trade ${usdtAmount} USDT: TriQuote caps every live trade at ${MAX_TRADE_USDT} USDT`);
  }
  const status = await walletStatus();
  if (!status.success || status.data?.status !== "CONNECTED") {
    throw new Error("Agentic Wallet is not connected. Run: baw auth signin --json");
  }
  const summary = await quoteTicker(ticker, usdtAmount);
  printTickerSummary(summary);
  if (!summary.best) {
    const reason = summary.toxic?.length > 0 ? "every live quote is toxic" : "no issuer has live liquidity";
    throw new Error(`Refusing to route ${summary.ticker}: ${reason} right now`);
  }
  const route = summary.best;
  console.log(color.bold(`\nRoute: ${usdtAmount} USDT → ${route.symbol} (${route.issuerName}) at ~${usd(route.pricePerShare, 4)}/share (${signedBps(route.premiumBps)} vs ref)`));
  if (!flags.confirm) {
    console.log(color.yellow("Dry run only. Re-run with --confirm to execute this swap on BSC mainnet."));
    return;
  }
  const submitted = await submitSwap({
    fromToken: USDT_BSC,
    toToken: route.address,
    fromTokenQty: usdtAmount,
    slippage: flags.slippage
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
  await logTrade({
    at: new Date().toISOString(),
    ticker: summary.ticker,
    usdtAmount,
    route: route.symbol,
    issuer: route.issuer,
    quotedPricePerShare: route.pricePerShare,
    referencePrice: summary.reference?.price ?? null,
    premiumBps: route.premiumBps,
    spreadBps: summary.spreadBps,
    savingsUsd: summary.savingsUsd,
    toxicBlocked: summary.toxic.map((quote) => quote.symbol),
    lossAvoidedUsd: summary.maxLossAvoidedUsd,
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
    console.log("Usage:\n  node src/cli.js scan [TICKERS...] [--all] [--usdt 5] [--json]\n  node src/cli.js best <TICKER> [--usdt 5] [--json]\n  node src/cli.js buy <TICKER> --usdt <amount<=5> [--confirm] [--slippage 1]");
    process.exitCode = commandName ? 1 : 0;
    return;
  }
  const { positional, flags } = parseArgs(rest);
  await command(positional, flags);
}

main().catch((error) => {
  console.error(color.red(`Error: ${error.message}`));
  process.exitCode = 1;
});
