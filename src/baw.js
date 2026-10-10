import { execFile } from "node:child_process";

const BSC_BINANCE_CHAIN_ID = "56";
const COMMAND_TIMEOUT_MS = 45000;
const ORDER_POLL_INTERVAL_MS = 3000;
const ORDER_POLL_TIMEOUT_MS = 90000;
const TERMINAL_ORDER_STATUSES = new Set(["FINISHED", "FAILED"]);

function parseBawOutput(stdout, stderr) {
  const text = (stdout || "").trim();
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) {
    return {
      success: false,
      error: { code: "NO_JSON", name: "CLI_OUTPUT_ERROR", message: (stderr || text || "baw returned no output").trim() }
    };
  }
  try {
    return JSON.parse(text.slice(jsonStart));
  } catch {
    return {
      success: false,
      error: { code: "BAD_JSON", name: "CLI_OUTPUT_ERROR", message: text.slice(0, 300) }
    };
  }
}

export function runBaw(args) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile("baw", [...args, "--json"], { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const latencyMs = Date.now() - startedAt;
      if (error && error.code === "ENOENT") {
        resolve({
          success: false,
          latencyMs,
          error: { code: "ENOENT", name: "CLI_NOT_FOUND", message: "baw CLI not found. Install it with: npm install -g @binance/agentic-wallet" }
        });
        return;
      }
      const result = parseBawOutput(stdout, stderr);
      resolve({ ...result, latencyMs });
    });
  });
}

export async function walletStatus() {
  return runBaw(["wallet", "status"]);
}

export async function quoteSwap({ fromToken, toToken, fromTokenQty, slippage }) {
  const args = [
    "market-order", "quote",
    "--fromTokenQty", String(fromTokenQty),
    "--fromToken", fromToken,
    "--toToken", toToken,
    "--binanceChainId", BSC_BINANCE_CHAIN_ID
  ];
  if (slippage !== undefined) {
    args.push("--slippage", String(slippage));
  }
  return runBaw(args);
}

export async function submitSwap({ fromToken, toToken, fromTokenQty, slippage }) {
  const args = [
    "market-order", "swap",
    "--fromTokenQty", String(fromTokenQty),
    "--fromToken", fromToken,
    "--toToken", toToken,
    "--binanceChainId", BSC_BINANCE_CHAIN_ID
  ];
  if (slippage !== undefined) {
    args.push("--slippage", String(slippage));
  }
  return runBaw(args);
}

export async function getOrder(orderId) {
  const result = await runBaw(["market-order", "list", "--orderId", String(orderId)]);
  if (!result.success) {
    return result;
  }
  const order = result.data?.list?.[0] ?? null;
  return { success: true, latencyMs: result.latencyMs, data: order };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForTerminalOrder(orderId, onUpdate = () => {}) {
  const deadline = Date.now() + ORDER_POLL_TIMEOUT_MS;
  let lastOrder = null;
  while (Date.now() < deadline) {
    const result = await getOrder(orderId);
    if (result.success && result.data) {
      lastOrder = result.data;
      onUpdate(lastOrder);
      if (TERMINAL_ORDER_STATUSES.has(lastOrder.status)) {
        return { terminal: true, order: lastOrder };
      }
    }
    await sleep(ORDER_POLL_INTERVAL_MS);
  }
  return { terminal: false, order: lastOrder };
}
