#!/bin/bash
cat > /data/state-0ef2851a-957e-4056-956a-9800f87afc0d.json << 'JSONEOF'
{
 "positions": {
 "1998122": {
 "lastHedge": {
 "symbol": "ETH",
 "size": 0.54472912798918,
 "notionalUsd": 1081.123836470627,
 "side": "short"
 },
 "lastPrice": 2039.2179066367773,
 "lastRebalancePrice": 1984.6998827867003,
 "lastRebalanceTimestamp": 1772810136955,
 "dailyRebalanceCount": 0,
 "dailyResetDate": "2026-03-10",
 "config": {
 "tokenId": 1998122,
 "protocolVersion": "v4",
 "poolAddress": "0x96d4b53a38337a5733179751781178a2613306063c511b78cd02684739288c0a",
 "activatedAt": 1772810130151,
 "hedgeSymbol": "ETH",
 "hedgeToken": "token0",
 "protectionType": "delta-neutral",
 "hedgeRatio": 0.9308,
 "cooldownSeconds": 14400000,
 "emergencyPriceMovementThreshold": 0.3,
 "token0Symbol": "ETH",
 "token1Symbol": "USDC",
 "token0Address": "0x0000000000000000000000000000000000000000",
 "token1Address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
 "token0Decimals": 18,
 "token1Decimals": 6,
 "fee": 500,
 "tickLower": -201360,
 "tickUpper": -199350,
 "chain": "base",
 "dex": "uniswap-v4",
 "positionId": 1998122
 },
 "pnl": {
 "initialLpUsd": 2296.8648971062894,
 "initialHlUsd": 942.484724,
 "initialLpFeesUsd": 0,
 "initialTimestamp": 1772810130151
 },
 "lastLiquidity": "526042179145057",
 "rebalances": [
 {
 "tokenId": 1998122,
 "timestamp": 1772810136955,
 "fromSize": 0,
 "toSize": 0.54472912798918,
 "fromNotional": 0,
 "toNotional": 1081.123836470627,
 "price": 1984.6998827867003,
 "coin": "ETH",
 "action": "SELL",
 "avgPx": 1984.9,
 "tradeValueUsd": 1081.1750299999999,
 "feeUsd": 0.46706761295999993,
 "triggerReason": "timer: 29546835.5min elapsed ≥ 240000min interval",
 "token0Symbol": "ETH",
 "token1Symbol": "USDC",
 "isEmergency": false
 }
 ]
 }
 }
}
JSONEOF

echo "Arquivo 1 criado"
ls -lah /data/
