---
name: triquote
description: Compare bStocks, Ondo and xStocks for a tokenized US stock on BSC and route a buy only to the cheapest safe issuer.
homepage: https://github.com/0xR-1/TriQuote
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "bins": ["triquote", "baw"] },
        "install":
          [
            {
              "id": "baw",
              "kind": "node",
              "package": "@binance/agentic-wallet",
              "bins": ["baw"],
              "label": "Install Binance Agentic Wallet CLI (npm)",
            },
          ],
      },
  }
---

# TriQuote

On BNB Smart Chain the same US stock trades as several tokens from different issuers: bStocks (`NVDAB`), Ondo (`NVDAon`) and xStocks (`NVDAx`). Prices differ, each token carries its own share multiplier, and some quotes come back `success: true` at a price that would lose most of the order. TriQuote quotes every issuer through Binance Agentic Wallet, normalizes per share, grades each quote and picks the cheapest safe route.

## When to use

Use this skill whenever the user wants to buy, price or compare a tokenized US stock or ETF on BSC, for example "buy 5 USDT of SPY", "which NVDA token is cheapest", or a symbol ending in `B`, `on` or `x`. Use it before any `baw market-order swap` into a tokenized stock.

## Get the route

```bash
triquote best <TICKER> --usdt <AMOUNT> --json
```

Use the plain ticker (`SPY`, `NVDA`, `TSLA`), not the issuer symbol. The JSON contains:

- `best`: the route to use (`symbol`, `issuerName`, `address`, `pricePerShare`, `premiumBps` vs the reference). `null` means no route is safe right now.
- `quotes`: every issuer with `grade` (`SAFE`, `CAUTION`, `TOXIC`) and `reasons` (`REF_PREMIUM`, `REF_DISCOUNT`, `ORACLE_DEVIATION`, `PEER_OUTLIER`, `MULTIPLIER_MISMATCH`).
- `toxic`, `suspect`, `caution`: quotes kept out of routing.
- `maxLossAvoidedUsd`: what the worst blocked route would have cost.
- `reference`: the US price used for comparison and the market status.

Tell the user the chosen issuer and price per share, which routes were blocked and why, and the loss avoided when it is not null.

## Rules

- Never route to a quote graded `TOXIC` or listed in `suspect`, even if the user names that token.
- If `best` is `null`, do not trade. Explain the reasons from `toxic`, `suspect` and `caution`.
- `CAUTION` routes are excluded by default. Only add `--allow-caution` if the user explicitly accepts the warning after you explain it.
- Do not call `baw market-order swap` directly for a tokenized stock. Execute through `triquote buy` so the route is re-quoted and re-graded immediately before the swap.

## Execute

First show the dry run:

```bash
triquote buy <TICKER> --usdt <AMOUNT>
```

Only after the user explicitly confirms the route and amount:

```bash
triquote buy <TICKER> --usdt <AMOUNT> --confirm
```

- Every trade is capped at 5 USDT and sent with a 1% slippage cap by default (`--slippage` accepts up to 5).
- Report success only when the output contains `FINISHED` and a BscScan link. An order id alone means submitted, not done.
- If the output says `FAILED` or still processing, say so and do not retry without asking.
