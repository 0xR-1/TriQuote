const RWA_DYNAMIC_URL = "https://www.binance.com/bapi/defi/v2/public/wallet-direct/buw/wallet/market/token/rwa/dynamic/ai";
const BSC_CHAIN_ID = "56";
const REQUEST_HEADERS = {
  "Accept-Encoding": "identity",
  "User-Agent": "binance-web3/1.1 (Skill)"
};

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function fetchDynamic(address) {
  try {
    const url = `${RWA_DYNAMIC_URL}?chainId=${BSC_CHAIN_ID}&contractAddress=${address}`;
    const response = await fetch(url, { headers: REQUEST_HEADERS });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return body.success ? body.data : null;
  } catch {
    return null;
  }
}

export async function getReference(listings) {
  const dynamics = await Promise.all(listings.map((listing) => fetchDynamic(listing.address)));
  const oracleByIssuer = {};
  const oraclePerSharePrices = [];
  const stockPrices = [];
  let marketStatus = null;
  listings.forEach((listing, index) => {
    const dynamic = dynamics[index];
    if (!dynamic) {
      return;
    }
    const tokenPrice = toNumber(dynamic.tokenInfo?.price);
    const multiplier = toNumber(dynamic.tokenInfo?.sharesMultiplier);
    const stockPrice = toNumber(dynamic.stockInfo?.price);
    const oraclePricePerShare = tokenPrice && multiplier ? tokenPrice / multiplier : tokenPrice;
    oracleByIssuer[listing.issuer] = { tokenPrice, multiplier, oraclePricePerShare };
    if (oraclePricePerShare) {
      oraclePerSharePrices.push(oraclePricePerShare);
    }
    if (stockPrice) {
      stockPrices.push(stockPrice);
    }
    marketStatus = marketStatus ?? dynamic.statusInfo?.marketStatus ?? null;
  });
  const usStockPrice = median(stockPrices);
  const oracleMedian = median(oraclePerSharePrices);
  return {
    usStockPrice,
    oracleMedian,
    referencePrice: usStockPrice ?? oracleMedian,
    referenceSource: usStockPrice ? "us-stock-last" : oracleMedian ? "oracle-median" : "none",
    marketStatus,
    oracleByIssuer
  };
}
