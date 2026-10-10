import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import type { RunWork } from "./sellerCore.js";

const SERVICE_NAME = "TriQuote best-execution route";
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const DEFAULT_USDT = 5;
const MAX_QUOTE_USDT = 1000;

interface TriQuoteRequest {
  ticker: string;
  usdt: number;
}

interface TriQuoteModules {
  quoteTicker: (ticker: string, usdtAmount: number) => Promise<Record<string, any>>;
  loadRegistry: () => Promise<Map<string, unknown[]>>;
}

let modules: Promise<TriQuoteModules> | null = null;

function triquoteRoot(): string {
  if (process.env.TRIQUOTE_ROOT) {
    return resolve(process.env.TRIQUOTE_ROOT);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

function moduleUrl(file: string): string {
  return pathToFileURL(resolve(triquoteRoot(), "src", file)).href;
}

function loadModules(): Promise<TriQuoteModules> {
  modules ??= Promise.all([import(moduleUrl("router.js")), import(moduleUrl("registry.js"))]).then(([router, registry]) => ({
    quoteTicker: router.quoteTicker,
    loadRegistry: registry.loadRegistry
  }));
  return modules;
}

function parseJsonObjects(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const candidate of text.match(/\{[\s\S]*\}/g) ?? []) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        found.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return found;
}

function clampUsdt(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return DEFAULT_USDT;
  }
  return Math.min(amount, MAX_QUOTE_USDT);
}

function requestText(prompt: string): { text: string; json: Record<string, unknown> | null } {
  for (const json of parseJsonObjects(prompt)) {
    if (typeof json.ticker === "string") {
      return { text: prompt, json };
    }
    if (typeof json.task === "string") {
      const inner = parseJsonObjects(json.task).find((item) => typeof item.ticker === "string") ?? null;
      return { text: json.task, json: inner };
    }
  }
  return { text: prompt, json: null };
}

export async function parseTriQuoteRequest(prompt: string, knownTickers: Set<string>): Promise<TriQuoteRequest | null> {
  const { text, json } = requestText(prompt);
  if (json && typeof json.ticker === "string" && knownTickers.has(json.ticker.trim().toUpperCase())) {
    return { ticker: json.ticker.trim().toUpperCase(), usdt: clampUsdt(json.usdt ?? json.amount) };
  }
  const upper = text.toUpperCase();
  const ticker = (upper.match(/[A-Z][A-Z0-9.]{0,9}/g) ?? []).find((word) => knownTickers.has(word));
  if (!ticker) {
    return null;
  }
  const amount = upper.match(/(\d+(?:\.\d+)?)\s*(?:USDT|USD)/) ?? upper.match(/\$\s*(\d+(?:\.\d+)?)/);
  return { ticker, usdt: clampUsdt(amount?.[1]) };
}

function roundOrNull(value: number | null | undefined, digits: number): number | null {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

function summarizeQuote(quote: Record<string, any>, best: Record<string, any> | null, usdt: number): Record<string, unknown> {
  const base = { issuer: quote.issuerName, symbol: quote.symbol, address: quote.address };
  if (!quote.available) {
    return { ...base, status: "unavailable", reason: quote.error };
  }
  const isBest = Boolean(best && best.issuer === quote.issuer);
  const status = quote.toxic ? "toxic" : quote.suspect ? "suspect" : isBest ? "best" : quote.caution ? "caution" : "safe";
  const summary: Record<string, unknown> = {
    ...base,
    status,
    grade: quote.grade ?? null,
    reasons: quote.reasons ?? [],
    pricePerShare: roundOrNull(quote.pricePerShare, 4),
    premiumVsReferenceBps: roundOrNull(quote.premiumBps, 0),
    sharesOut: quote.sharesOut,
    multiplier: quote.multiplier
  };
  if (quote.toxic && best) {
    summary.lossIfRoutedUsd = roundOrNull(usdt * (1 - quote.sharesOut / best.sharesOut), 4);
  }
  return summary;
}

export function buildTriQuoteReport(summary: Record<string, any>): Record<string, unknown> {
  const usdt = summary.usdtAmount;
  const best = summary.best ?? null;
  return {
    service: SERVICE_NAME,
    ticker: summary.ticker,
    usdt,
    quotedAt: summary.quotedAt,
    reference: summary.reference ?? null,
    verdict: best ? `Route ${usdt} USDT to ${best.symbol} (${best.issuerName})` : "No safe route available right now",
    bestRoute: best
      ? {
          issuer: best.issuerName,
          symbol: best.symbol,
          address: best.address,
          pricePerShare: roundOrNull(best.pricePerShare, 4),
          premiumVsReferenceBps: roundOrNull(best.premiumBps, 0)
        }
      : null,
    routes: (summary.quotes ?? []).map((quote: Record<string, any>) => summarizeQuote(quote, best, usdt)),
    safeSpreadBps: roundOrNull(summary.spreadBps, 1),
    toxicBlocked: (summary.toxic ?? []).map((quote: Record<string, any>) => quote.symbol),
    suspectHeld: (summary.suspect ?? []).map((quote: Record<string, any>) => quote.symbol),
    cautionHeld: (summary.caution ?? []).map((quote: Record<string, any>) => quote.symbol),
    maxLossAvoidedUsd: roundOrNull(summary.maxLossAvoidedUsd, 4),
    multiplierFlipsWinner: Boolean(summary.multiplierFlipsWinner),
    executeWith: best
      ? `baw market-order swap --fromTokenQty ${usdt} --fromToken ${USDT_BSC} --toToken ${best.address} --binanceChainId 56 --json`
      : null
  };
}

export function buildTriQuoteWork(): RunWork {
  return async (prompt) => {
    const { quoteTicker, loadRegistry } = await loadModules();
    const registry = await loadRegistry();
    const request = await parseTriQuoteRequest(prompt, new Set(registry.keys()));
    if (!request) {
      return JSON.stringify({
        service: SERVICE_NAME,
        error: "No supported ticker found. Send {\"ticker\":\"NVDA\",\"usdt\":5} or text like \"NVDA 5 USDT\"."
      });
    }
    const summary = await quoteTicker(request.ticker, request.usdt);
    if (summary.error) {
      return JSON.stringify({ service: SERVICE_NAME, ticker: request.ticker, error: summary.error });
    }
    return JSON.stringify(buildTriQuoteReport(summary), null, 2);
  };
}
