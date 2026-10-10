# TriQuote

**One ticker. Three issuers. The cheapest *safe* fill on BNB Chain.**

TriQuote is a best-execution router and toxic-quote shield for tokenized US stocks on BNB Smart Chain. For any ticker it quotes every issuer that lists it — **bStocks**, **Ondo** and **xStocks** — through **Binance Agentic Wallet**, normalizes each quote by the token's live share multiplier, checks it against an independent reference price, blocks toxic fills, and routes the order to the cheapest safe issuer.

Built for **BNB Hack: Tokenized Stocks Edition**.

![TriQuote live dashboard on BSC mainnet at a 100 USDT order size: SPYx blocked as TOXIC, MSFT held as CAUTION, Ondo and bStocks routed](docs/dashboard-live.png)

*Live dashboard against BSC mainnet with a connected Agentic Wallet, 100 USDT order size. The xStocks SPY route is blocked for four independent reasons; routing there would have lost **$91.72 of $100**. Both live MSFT routes are held as `CAUTION` because the on-chain oracle disagrees with them.*

---

## Why this exists

On BSC the same stock exists as several different tokens. NVIDIA alone is `NVDAB` (bStocks), `NVDAon` (Ondo) and `NVDAx` (xStocks). A user who just wants "NVIDIA" faces three problems the wallet does not solve for them:

1. **Prices differ between issuers.** Liquidity is fragmented, so the same dollar buys a different number of shares depending on the token.
2. **Tokens are not 1 share.** Each token carries a *share multiplier* (cumulative dividend reinvestment, splits). Comparing raw token amounts picks the wrong issuer.
3. **Some quotes are toxic.** Off-hours liquidity is thin, and a quote can come back `success: true` at a price that would wipe out most of the order.

## What we observed (live, Saturday 10 Oct 2026, US market off-hours)

All numbers below were produced by TriQuote against BSC mainnet, for a 5 USDT order unless a row says otherwise.

| Finding | Detail |
|---|---|
| **Toxic quote returned as success** | `SPYx` quoted at **$8,912 / share** vs a US reference of **$779.87**. Routing there would lose **$4.57 of $5 (91%)**. `baw market-order quote` returned `success: true` with no warning. TriQuote flagged and blocked it. |
| **It is a mispriced route, not a units bug** | Re-quoting `SPYx` at 0.5, 5 and 50 USDT gave **$8,944, $8,964 and $9,161 per token** — about **11.5× the reference at every size**. A decimals error would be an exact power of ten; thin depth would start near the reference and climb. Instead the route itself is priced ~11.5× off from the first cent. |
| **Same toxic route at 100 USDT** | A later live scan at a **100 USDT** order size priced `SPYx` at **$9,329 / share** vs a **$779.34** reference: routing there would lose **$91.72 of $100**. TriQuote blocked it again and routed to `SPYon`, 83 bps below the reference. |
| **Four independent red flags on one quote** | TriQuote's grader marks that `SPYx` route `TOXIC` for `REF_PREMIUM`, `ORACLE_DEVIATION`, `PEER_OUTLIER` and `MULTIPLIER_MISMATCH` at the same time. In the 5 USDT scan of the 10-ticker watchlist it is the only quote that fails any check. |
| **xStocks registry multipliers are stale** | For 8 of 10 xStocks tokens the registry multiplier (`1`) disagrees with the dynamic endpoint by up to **57 bps**. For every Ondo and bStocks token the two sources agree exactly. |
| **Multiplier flips the winner** | On SPY, META, QQQ and AAPL the issuer that returns the most *tokens* is **not** the issuer that returns the most *shares*. |
| **Off-hours discount** | Best safe SPY route (`SPYon`) filled **74 bps below** the last US price. |
| **Fragmented coverage** | Binance's registry lists **40 tickers on all three issuers** and **121 on at least two** on BSC. |
| **xStocks liquidity gap** | **9 of 10** xStocks tokens in our watchlist returned `No liquidity available` during off-hours. |
| **Safe-issuer spreads** | Up to **~49 bps** between the two safe issuers on the same ticker at 5 USDT (SPY, MSFT), and **~60 bps** on SPY at 100 USDT. |
| **Oracle disagreement holds routes back** | In the 100 USDT scan, both live MSFT routes were within 45 bps of the US price but more than 300 bps from the on-chain oracle median, so both were graded `CAUTION` and not routed without `--allow-caution`. |

## Features

- **Cross-issuer radar** — scans a watchlist (or every multi-issuer ticker) and ranks by spread.
- **Per-share normalization** — `pricePerShare = usdtIn / (tokensOut × multiplier)`, using the live multiplier from Binance.
- **Reference price** — US last price from Binance's tokenized-securities API, falling back to the median oracle price per share.
- **Multi-signal grading** — every quote is checked against three independent prices (US last price, on-chain oracle median, median of all issuers) plus agreement between Binance's two multiplier sources. Each quote gets a grade and the reasons behind it:
  - `SAFE` — no warning, routable.
  - `CAUTION` — exactly one warning; left out unless `--allow-caution` is passed.
  - `TOXIC` — two or more warnings, or one deviation above 2,000 bps, and overpriced; never routed, and the loss it would have caused is reported.
  - `SUSPECT` — same bar but implausibly cheap (likely bad data, not a bargain); never routed.
- **Best-route execution** — buys the cheapest safe issuer via `baw market-order swap` with an explicit slippage cap (1% by default, 5% max), hard-capped at **5 USDT**, dry-run by default, and only reported as done once the order reaches `FINISHED`.
- **Fill verification** — after a swap finishes, TriQuote measures the tokens actually received (wallet balance before vs after) and logs the real price per share against both the quote and the reference.
- **Replay mode** — `scan --save` records a live scan; the dashboard can replay it with no wallet, so anyone can inspect real results.
- **Live dashboard** — local web UI with KPIs, per-issuer cells (★ BEST / ☠ TOXIC / NO LIQUIDITY) and an execution log.
- **Agent-to-agent service** — a BNB Agent Studio seller agent (ERC-8004 identity **#2586**) that sells TriQuote route reports to other agents over A2A and MCP, paid through ERC-8183 escrow.

## Binance Web3 stack used

| Component | How TriQuote uses it |
|---|---|
| **Agentic Wallet (`baw` CLI)** | `market-order quote` for every issuer, `market-order swap` for execution, `market-order list` to poll to a terminal state, `wallet status` before trading |
| **Tokenized securities registry** | `.../rwa/stock/detail/list/ai` — maps each ticker to its bStocks / Ondo / xStocks contracts and multipliers on BSC |
| **Tokenized securities dynamic data** | `.../rwa/dynamic/ai` — live share multiplier, oracle token price, US stock price and market status per token |
| **BNB Agent Studio (`bag` CLI)** | Seller agent scaffold, ERC-8004 identity registration, ERC-8183 signed quotes and escrowed delivery, A2A + MCP faces |

## Architecture

```mermaid
flowchart TD
    U([User: buy NVDA with 5 USDT]) --> R

    subgraph Resolve
        R[registry.js<br/>Binance RWA registry]
        R --> L1[bStocks · NVDAB]
        R --> L2[Ondo · NVDAon]
        R --> L3[xStocks · NVDAx]
    end

    subgraph Quote["Quote in parallel"]
        Q[baw.js<br/>Agentic Wallet<br/>market-order quote]
        F[reference.js<br/>RWA dynamic<br/>multiplier · oracle · US price]
    end

    L1 & L2 & L3 --> Q
    L1 & L2 & L3 --> F

    Q --> RT
    F --> RT

    subgraph Route["router.js"]
        RT[Normalize per share] --> P[Premium vs reference]
        P --> G{Grade: reference · oracle ·<br/>issuer median · multiplier check}
        G -->|2+ warnings, overpriced| X[☠ TOXIC<br/>blocked]
        G -->|2+ warnings, too cheap| SU[⚠ SUSPECT<br/>held back]
        G -->|1 warning| C[? CAUTION<br/>opt-in only]
        G -->|no warning| S[✓ SAFE]
        S --> B[★ Rank by shares out<br/>pick best]
    end

    B --> CLI[cli.js<br/>scan · best · buy]
    B --> SRV[server.js<br/>dashboard API]
    SRV --> UI[public/index.html<br/>live dashboard]
    CLI -->|confirmed buy| SW[baw market-order swap<br/>max 5 USDT]
    SW --> PL{Poll order}
    PL -->|FINISHED| OK([Done · BscScan tx<br/>fill measured from balance])
    PL -->|FAILED| KO([Reported as failed])

    classDef toxic fill:#ff5c6c,stroke:#ff5c6c,color:#fff
    classDef best fill:#2fd98b,stroke:#2fd98b,color:#062
    classDef wallet fill:#f0b90b,stroke:#f0b90b,color:#111
    classDef suspect fill:#ffb547,stroke:#ffb547,color:#2a1a00
    class X toxic
    class SU,C suspect
    class B,OK best
    class Q,SW wallet
```

| File | Responsibility |
|---|---|
| `src/registry.js` | Fetches and caches the tokenized-stock registry, groups BSC listings by ticker |
| `src/baw.js` | Thin wrapper over the `baw` CLI with latency measurement and order polling |
| `src/reference.js` | Reference price, live multipliers and market status per issuer |
| `src/router.js` | Quotes all issuers in parallel, normalizes, grades each quote with reasons, ranks routes (pure `assessQuotes` / `summarizeRoutes`) |
| `src/cli.js` | `scan`, `best`, `buy` commands |
| `src/server.js` | Local HTTP API + dashboard server, with `--replay` for recorded scans |
| `snapshots/` | Recorded live scans for replay |
| `test/router.test.js` | `node --test` suite built on the live 10 Oct 2026 SPY quotes |
| `public/index.html` | Dashboard UI (no external dependencies) |

## TriQuote as an agent (BNB Agent Studio)

`triquoteagent/` is a BNB Agent Studio seller agent that turns TriQuote into a service other AI agents can discover, pay and call. Instead of an LLM, its work hook runs the TriQuote engine and returns a structured route report.

| Item | Value |
|---|---|
| ERC-8004 identity | **Agent #2586** on BSC testnet, registry `eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Agent wallet | `0xF2cb1E553a98705C0b00774DC4a3e015324115e5` |
| Faces | A2A (`/.well-known/agent-card.json`) and MCP (`/mcp`) |
| Commerce rail | ERC-8183 escrow on BSC testnet, **0.01 U per route report** |
| Work hook | `triquoteagent/app/agent/src/triquoteWork.ts` → `src/router.js` |

```mermaid
sequenceDiagram
    participant Buyer as Buyer agent
    participant TQ as TriQuote agent 2586
    participant Chain as BSC (ERC-8183 escrow)
    participant Engine as TriQuote engine
    participant AW as Agentic Wallet (baw)

    Buyer->>TQ: negotiate (SPY, 5 USDT)
    TQ-->>Buyer: wallet-signed quote (0.01 U)
    Buyer->>Chain: createJob + fund
    Buyer->>TQ: notify_funded job_id
    TQ->>Chain: verify signed + funded job
    TQ->>Engine: quoteTicker SPY 5
    Engine->>AW: market-order quote for 3 issuers
    Engine-->>TQ: best route, toxic quotes, spreads
    TQ->>Chain: submit deliverable
    Buyer->>Chain: read deliverable
    Buyer->>AW: execute the returned swap command
```

The agent sells **route intelligence**, not execution: the report ends with the exact `baw market-order swap` command, so the buyer executes in its own Agentic Wallet and never hands over funds.

> **Where it runs.** The work hook imports the TriQuote engine from this repository's `src/` folder and quotes through the local `baw` session. It is meant to run with `bag dev` on a machine that has both. It has **not** been deployed to a hosted runtime: a deployed bundle would contain only `app/agent` and no signed-in `baw`, so every route would come back unavailable. The on-chain identity (#2586) therefore advertises a `localhost` endpoint.

Example deliverable (live, 10 Oct 2026):

```json
{
  "service": "TriQuote best-execution route",
  "ticker": "SPY",
  "usdt": 5,
  "reference": { "price": 780.075, "source": "us-stock-last", "marketStatus": "offhours" },
  "verdict": "Route 5 USDT to SPYon (Ondo)",
  "bestRoute": { "issuer": "Ondo", "symbol": "SPYon", "pricePerShare": 774.2867, "premiumVsReferenceBps": -74 },
  "routes": [
    { "issuer": "Ondo", "symbol": "SPYon", "status": "best", "pricePerShare": 774.2867, "premiumVsReferenceBps": -74 },
    { "issuer": "xStocks", "symbol": "SPYx", "status": "toxic", "reasons": ["REF_PREMIUM", "ORACLE_DEVIATION", "PEER_OUTLIER", "MULTIPLIER_MISMATCH"], "pricePerShare": 8912.2702, "premiumVsReferenceBps": 104249, "lossIfRoutedUsd": 4.5656 },
    { "issuer": "bStocks", "symbol": "SPYB", "status": "safe", "pricePerShare": 778.0066, "premiumVsReferenceBps": -27 }
  ],
  "toxicBlocked": ["SPYx"],
  "executeWith": "baw market-order swap --fromTokenQty 5 --fromToken 0x55d3...7955 --toToken 0x6a70...331a --binanceChainId 56 --json"
}
```

### Run the agent

Requires Node.js 22+, pnpm 10 and the Agent Studio CLI.

```bash
npm install -g @bnbagent/studio-cli
cd triquoteagent
pnpm install
cd app/agent
bag wallet new --generate-password
bag doctor
cd ../..
bag dev
```

Ask the agent for a signed quote:

```bash
curl -s http://localhost:9000/ -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"kind":"message","messageId":"tq-1","role":"user","parts":[{"kind":"data","data":{"skill":"negotiate","task_description":"{\"ticker\":\"SPY\",\"usdt\":5}","terms":{"deliverables":"TriQuote route report","quality_standards":"All issuers quoted"}}}]}}}'
```

## Run it

### Fastest: replay a recorded live scan (no wallet needed)

```bash
git clone https://github.com/0xR-1/TriQuote.git
cd TriQuote
node src/server.js --replay snapshots/scan-2026-10-10.json
```

Open <http://localhost:4173>. This replays a real scan captured on BSC mainnet on 10 Oct 2026 (US market off-hours), including the toxic `SPYx` quote.

![TriQuote dashboard in replay mode showing the recorded 10 Oct 2026 scan](docs/dashboard.png)

### Prerequisites

- Node.js **20+**
- Binance Agentic Wallet CLI **1.10.0+**
- An Agentic Wallet created in the Binance App and signed in on this machine

```bash
npm install -g @binance/agentic-wallet
baw auth signin --json
baw auth verify --qrCodeId <qrCodeId from signin> --json
baw wallet status --json
```

Quoting does **not** require any balance. Executing a buy requires USDT (and a little BNB for gas) on **BSC** in the Agentic Wallet.

### Install

```bash
git clone https://github.com/0xR-1/TriQuote.git
cd TriQuote
```

No `npm install` is needed — TriQuote has zero runtime dependencies.

### CLI

```bash
node src/cli.js best SPY
node src/cli.js scan
node src/cli.js scan NVDA TSLA AAPL --usdt 5
node src/cli.js scan --all
node src/cli.js scan --save snapshots/my-scan.json
node src/cli.js best SPY --allow-caution
node src/cli.js buy NVDA --usdt 5
node src/cli.js buy NVDA --usdt 5 --confirm
node src/cli.js buy NVDA --usdt 5 --confirm --slippage 0.5
```

`buy` without `--confirm` is a dry run: it shows the route it *would* take, including the slippage cap, and stops. `--slippage` is a percentage; it defaults to **1** and anything outside (0, 5] is rejected, so a swap is never sent with `baw`'s `auto` slippage.

Example output (`best SPY`, 10 Oct 2026):

```
SPY  ·  5 USDT  ·  2 safe / 3 live / 3 listed
  ref $779.87 (US last price) · market offhours
  ★ Ondo     SPYon         $774.0884 /share      -74 bps vs ref   x1.009473   3835ms
  ☠ xStocks  SPYx         $8912.3343 /share  +104280 bps vs ref   x1.005715   3191ms   TOXIC · would lose $4.57 [REF_PREMIUM, ORACLE_DEVIATION, PEER_OUTLIER, MULTIPLIER_MISMATCH]
  · bStocks  SPYB          $777.8106 /share      -26 bps vs ref   x1.001730   3179ms
  spread 48.1 bps between safe issuers · best vs worst saves $0.0239
  best route is 74 bps BELOW the reference price
  blocked 1 toxic quote(s) priced >300 bps over reference · avoided losing up to $4.57
  ! raw token amounts point to a different issuer; share multipliers change the winner
```

### Tests

```bash
npm test
```

Eight `node --test` cases, no dependencies and no network: the live SPY quotes from 10 Oct 2026 (SPYx graded TOXIC for all four reasons, $4.57 loss avoided), the multiplier flipping the winner, a suspiciously cheap quote being held back, CAUTION being opt-in, the issuer-median signal abstaining when only two issuers are live, and unavailable issuers never being routed.

### Dashboard

```bash
node src/server.js
node src/server.js --replay snapshots/scan-2026-10-10.json
```

Open <http://localhost:4173>. A live scan of 10 tickers takes roughly 15–30 seconds; results are cached for 60 seconds. In replay mode the dashboard shows the recorded scan and never calls the wallet.

## Safety

- Every live trade is capped at **5 USDT** in code.
- `buy` is a **dry run** unless `--confirm` is passed.
- Every swap carries an explicit slippage cap (1% default, 5% max) instead of `auto`. TriQuote does not override `baw`'s MEV protection, which is on by default.
- `buy --confirm` quotes and grades all issuers again immediately before submitting, so it never executes on an old quote.
- Only `SAFE` quotes are routed by default; `CAUTION` needs `--allow-caution`; `TOXIC` and `SUSPECT` are **never** routed. If nothing routable is left, `buy` refuses.
- After a finished swap, the received amount is measured from the wallet balance; if it cannot be measured, the trade is logged as **not verified** rather than assumed.
- A swap is reported as successful **only** after `baw market-order list` shows `FINISHED`; an `orderId` alone is treated as "submitted".
- No API keys, private keys or wallet secrets are read or stored by TriQuote. Wallet authentication is handled entirely by the `baw` CLI.

## Known limitations

We prefer to state these plainly:

- **Runs locally.** Quoting and execution go through the `baw` CLI, which needs a signed-in Agentic Wallet session on the same machine. There is no hosted deployment.
- **Quotes are indicative, not firm.** The executed price can differ from the quote within the slippage cap (1% by default).
- **The thresholds are heuristics.** 300 bps vs reference/oracle, 500 bps vs the issuer median, 50 bps of multiplier disagreement and 2,000 bps "extreme" are tuned to catch broken off-hours routes, not ordinary premiums or weekend discounts. They are not yet tightened for market hours.
- **The issuer-median signal needs three live issuers.** With only two, a median cannot tell which one is wrong, so that signal abstains and grading relies on the reference, the oracle and the multiplier check.
- **A disagreeing oracle can hold back a sound route.** `ORACLE_DEVIATION` fires when a quote is more than 300 bps from the on-chain oracle median, even if it sits close to the US price. If the oracle is the outlier, TriQuote stays conservative and marks the route `CAUTION` instead of guessing which source is wrong; `--allow-caution` routes it anyway.
- **Off-hours reference.** When the US market is closed the reference is the *last* US price, so a genuine weekend move can look like a premium or discount.
- **Two sources disagree on multipliers.** For xStocks the registry and the dynamic endpoint differ by up to 57 bps. TriQuote prices with the dynamic value and raises `MULTIPLIER_MISMATCH` when they disagree by more than 50 bps.
- **Fees and gas are not in the ranking.** `baw market-order quote` returns the output amount and slippage only; it does not break out gas or wallet trading fees. Every route is bought from the same wallet on the same chain, so TriQuote ranks on quoted output alone.
- **Unknown issuer types ignored.** The registry also returned `type` values `4` and `9`, which are undocumented; TriQuote only routes types 1 (Ondo), 2 (xStocks) and 3 (bStocks).
- **Buy only.** There is no sell or rebalance route yet.
- **Latency.** Each quote takes ~1.7–3.8 s; a full `--all` scan quotes hundreds of routes and is slow.
- **Live execution status:** see the execution log in the dashboard. If it is empty, no live swap has been run from this repository yet.
- **Agent runs on testnet and locally.** The Agent Studio agent is registered on BSC testnet with a `localhost` endpoint; it was not deployed to a public runtime (the managed platform requires Bun and is a 48-hour testnet trial). Its quotes still come from BSC mainnet through `baw`.
- **x402 rail not enabled.** B402 merchant credentials are issued only after manual approval, so the agent uses the ERC-8183 escrow rail instead.
- **Paid job flow verified in parts.** Negotiation (wallet-signed quote) and the delivery work hook were verified live. A full funded ERC-8183 job additionally needs a separate buyer wallet holding the escrow's test asset; that end-to-end run is not included here.

## Next steps

- **Size-aware routing:** quote each issuer at several order sizes and route on the effective price at the actual order size, since the best issuer at 5 USDT is not always the best at 100.
- **Contract-level issuer risk:** read pause, blacklist, owner and upgradeability state for each token contract and show it next to the price, without mixing it into the price grade.
- **Market-hours thresholds:** tighten the reference and oracle bands while the US market is open, once they can be calibrated on market-hours data.
- **Sell route:** pick the issuer that pays the most per share when exiting.
- **Daily circuit breaker:** stop live execution after a daily loss or repeated failed orders, read from the trade log.
- **Public agent endpoint:** expose the Agent Studio agent through a tunnel or hosted runtime so other agents can reach it without running it locally.

## License

MIT
