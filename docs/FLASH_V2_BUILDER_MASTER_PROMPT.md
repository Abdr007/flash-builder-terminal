# Flash Magic Terminal Master Prompt

You are building `flash-magic-terminal`, a production-grade terminal for the Flash Trade V2 Builder API.

Your scope is strict:

- Use only the official Flash Trade V2 Builder API and its documented WebSocket stream.
- Use only the documented REST base URL `https://flashapi.trade`.
- Use only the documented transaction submission split:
  - account and funds transactions to the user's Solana RPC
  - trading transactions to the Flash Trade V2 RPC endpoint
- Do not invent any endpoints, fields, enums, response shapes, or program behavior.
- Do not use Flash SDK v2, MCP wrappers, deprecated V1 APIs, or synthetic abstractions unless the V2 docs explicitly require them.

## Non-negotiable source of truth

Before writing any implementation, re-read and obey these official docs:

- `Flash Trade V2 API`
- `Quickstart`
- `Signing & submitting`
- `Core concepts`
- `The Basket model`
- `Funds lifecycle`
- `Prices & markets`
- `How transactions work`
- `Guides`
- `API reference`
- `Conventions`
- `Market data`
- `Account & positions`
- `Previews`
- `Trading`
- `Account & funds`
- `WebSocket`
- `Errors`
- `HTTP errors`
- `On-chain error codes`
- `Recovery patterns`
- `Partner Referral Program`

If a detail is not documented there, stop and verify it from the docs before coding. If it still is not documented, do not guess.

## Product goal

Build a terminal that lets a power user or agent:

- inspect prices, pools, markets, and basket state
- preview trades before committing
- open, close, increase, decrease, and reverse positions
- place, edit, and cancel limit orders
- place, edit, and cancel TP/SL trigger orders
- deposit, delegate, withdraw, and settle funds
- stream live basket updates over WebSocket
- surface errors precisely and recover from them deterministically

## Terminal experience goal

The terminal itself must expose the docs-backed product surface as first-class commands, not hidden internals.

Minimum command families:

- market data: health, tokens, prices, pool-data, raw accounts
- account state: basket snapshot, positions, orders, delegation status
- previews: limit fees, exit fee, TP/SL, margin change
- trading: open, close, increase, decrease, reverse
- risk: TP, SL, combined TP/SL, limit order placement/edit/cancel
- funds: deposit, deposit-direct, init basket, init deposit ledger, delegate basket, withdraw, custody settlement, withdrawal settle, request withdrawal
- streaming: basket websocket stream, live metrics
- recovery: receipt polling, withdrawal recovery, stale-price handling, blockhash expiry, error decoding
- partner routing: referral/builder attribution through documented fields only

Every command must have:

- deterministic parsing
- explicit required/optional args
- docs-aligned defaults only
- consistent JSON output in agent mode
- human-readable output in interactive mode
- no hidden side effects

## Hard architectural rules

- Treat the basket as the only source of truth for positions and orders.
- Treat trade responses as quotes or builder outputs, not confirmed state.
- Re-read committed state from `GET /owner/{owner}` or the WebSocket after submission.
- Do not reconstruct position state from transaction responses alone.
- Do not hand-assemble instructions when the API provides a transaction builder.
- Decode, sign, and submit only the unsigned v0 transactions returned by the API.
- Route each transaction to the correct RPC or it must fail:
  - `deposit`, `deposit-direct`, `init-*`, `delegate-basket`, `withdraw`, `custody-settlement`, `withdrawal-settle`, `request-withdrawal` -> Solana RPC
  - `open-position`, `close-position`, `increase-position`, `decrease-position`, `reverse-position`, collateral actions, trigger actions, limit actions -> Flash Trade V2 RPC
- Respect the `owner != feePayer` requirement for withdrawal flows.
- If the docs say a builder supports preview-only mode, implement it exactly.
- If the docs say a field is optional, preserve that exact optionality.
- If the docs say a field is required, reject the request without attempting fallback behavior.

## Documented API surface to implement

### Market data

Implement reads for:

- `GET /health`
- `GET /tokens`
- `GET /prices`
- `GET /prices/{symbol}`
- `GET /pool-data`
- `GET /pool-data/{pubkey}`
- `GET /raw/pools`
- `GET /raw/pools/{pubkey}`
- `GET /raw/custodies`
- `GET /raw/custodies/{pubkey}`
- `GET /raw/markets`
- `GET /raw/markets/{pubkey}`
- `GET /raw/perpetuals`
- `GET /raw/perpetuals/{pubkey}`
- `GET /raw/baskets/{pubkey}`

Request rules:

- `GET /prices/{symbol}` must accept the exact token symbol used by the pool config.
- `GET /pool-data/{pubkey}` must accept the documented pool public key.
- raw account endpoints must preserve the raw Anchor-deserialized shape.
- do not invent `/raw/positions` or `/raw/orders`; positions and orders are in the basket.

### Account and positions

Implement reads for:

- `GET /owner/{owner}`
- `GET /positions/owner/{owner}`
- `GET /orders/owner/{owner}`

Response rules:

- treat the basket snapshot as the canonical state source
- `positionMetrics` and `orderMetrics` are keyed by market pubkey
- `basketData` is base64 raw basket bytes
- UI-ready values must be rendered from the documented metrics fields, not reconstructed heuristically

### Previews

Implement previews for:

- `POST /preview/limit-order-fees`
- `POST /preview/exit-fee`
- `POST /preview/tp-sl`
- `POST /preview/margin`

Preview rules:

- previews are read-only computations
- quote failures return `{ "err": "..." }` in a `200` body
- `preview/tp-sl` must support `forward`, `reverse_pnl`, and `reverse_roi`
- `preview/margin` must support `ADD` and `REMOVE`
- do not submit transactions from preview endpoints

### Trading builders

Implement builders for:

- `POST /transaction-builder/open-position`
- `POST /transaction-builder/close-position`
- `POST /transaction-builder/increase-position`
- `POST /transaction-builder/decrease-position`
- `POST /transaction-builder/reverse-position`
- `POST /transaction-builder/add-collateral`
- `POST /transaction-builder/remove-collateral`
- `POST /transaction-builder/place-trigger-order`
- `POST /transaction-builder/place-tp-sl`
- `POST /transaction-builder/edit-trigger-order`
- `POST /transaction-builder/cancel-trigger-order`
- `POST /transaction-builder/cancel-all-trigger-orders`
- `POST /transaction-builder/edit-limit-order`
- `POST /transaction-builder/cancel-limit-order`

Trading field rules:

- `open-position` fields:
  - `inputTokenSymbol`
  - `outputTokenSymbol`
  - `inputAmountUi`
  - `leverage`
  - `tradeType`
  - optional `orderType`
  - optional `limitPrice`
  - optional `owner`
  - optional `slippagePercentage`
  - optional `takeProfit`
  - optional `stopLoss`
- `close-position` fields:
  - `marketSymbol`
  - `side`
  - `inputUsdUi`
  - optional `closeAll`
  - `withdrawTokenSymbol`
  - `owner`
  - optional `slippagePercentage`
- `increase-position` / `decrease-position` fields:
  - `marketSymbol`
  - `side`
  - `owner`
  - `sizeAmountUi`
  - `collateralAmountUi` only for increase
  - `collateralTokenSymbol` only for increase
  - `withdrawTokenSymbol` only for decrease
  - optional `slippagePercentage`
- `reverse-position` fields:
  - `marketSymbol`
  - `side`
  - `leverage`
  - `owner`
  - optional `slippagePercentage`
- collateral builders:
  - `marketSymbol`
  - `side`
  - `owner`
  - `depositAmountUi` + `depositTokenSymbol` for add
  - `withdrawAmountUsdUi` + `withdrawTokenSymbol` for remove
- trigger builders:
  - `place-trigger-order`: `marketSymbol`, `side`, `owner`, `triggerPriceUi`, `sizeAmountUi`, `isStopLoss`
  - `place-tp-sl`: `marketSymbol`, `side`, `owner`, `sizeAmountUi`, optional `takeProfitUi`, optional `stopLossUi`
  - `edit-trigger-order`: `marketSymbol`, `side`, `owner`, `orderId`, `isStopLoss`, `triggerPriceUi`, `sizeAmountUi`
  - `cancel-trigger-order`: `marketSymbol`, `side`, `owner`, `orderId`, `isStopLoss`
  - `cancel-all-trigger-orders`: `marketSymbol`, `side`, `owner`
- limit builders:
  - `edit-limit-order`: `marketSymbol`, `side`, `owner`, `orderId`, optional `limitPriceUi`, optional `sizeAmountUi`, optional `takeProfitUi`, optional `stopLossUi`
  - `cancel-limit-order`: `marketSymbol`, `side`, `owner`, `orderId`

### Funds builders

Implement builders for:

- `POST /transaction-builder/deposit`
- `POST /transaction-builder/deposit-direct`
- `POST /transaction-builder/init-basket`
- `POST /transaction-builder/init-deposit-ledger`
- `POST /transaction-builder/delegate-basket`
- `POST /transaction-builder/withdraw`
- `POST /transaction-builder/custody-settlement`
- `POST /transaction-builder/withdrawal-settle`
- `POST /transaction-builder/request-withdrawal`

Funds field rules:

- `deposit` fields: `owner`, `tokenSymbol`, `amount`
- `deposit-direct` fields: `owner`, optional `fundingOwner`, `tokenMint`, `amount`
- `init-basket` and `init-deposit-ledger` fields: `owner`, optional `payer`
- `delegate-basket` fields: `owner`, optional `payer`
- `withdraw` fields: `owner`, `tokenSymbol`, `amount`, `feePayer`, optional `feePayerTopUpLamports`
- `custody-settlement` fields: `owner`, `tokenSymbol`
- `withdrawal-settle` fields: `owner`, `tokenMint`
- `request-withdrawal` fields: `owner`, `tokenMint`, `amount`, `feePayer`

Funds rules:

- `withdraw` and `request-withdrawal` require `feePayer !== owner`
- `deposit` should prefer bundled setup when available
- `deposit-direct` is the lower-level no-bundle variant
- `custody-settlement` is only for the `custodySettlementRequired: true` withdrawal case
- `withdrawal-settle` is only for resuming a pending withdrawal
- a confirmed withdrawal may still need receipt polling before the funds are actually spendable

### Partner referral

If the terminal exposes a builder-code or partner-routing input, it must use the documented request field:

- `referralAccount`

Do not invent other referral fields or hidden attribution headers.

### WebSocket

Implement:

- `wss://flashapi.trade/owner/{owner}/ws?updateIntervalMs=...`
- initial `basket` snapshot handling
- subsequent `basket` refresh handling
- `metrics` tick handling
- ping/pong behavior
- connection limit handling

WebSocket rules:

- first message must be the full `basket` snapshot
- later `basket` messages replace the canonical local basket view
- `metrics` messages are lightweight refresh ticks
- respect the documented per-owner and global limits
- surface disconnects and close reasons to the user

## Required request semantics

Use the exact documented request keys and value types.

Examples of critical rules:

- UI amounts are decimal strings.
- Position identity is `(owner, marketSymbol, side)`.
- Trade type values are `LONG` and `SHORT`.
- Order type values are `MARKET` and `LIMIT`.
- Margin action values are `ADD` and `REMOVE`.
- Omit `owner` on `open-position` only when intentionally requesting preview-only mode.
- For limit and trigger order edits, preserve the documented “omit means keep existing” behavior exactly where the docs say it exists.
- For `withdraw`, require a distinct `feePayer`.
- For referral routing, use the documented `referralAccount` field when the product needs partner attribution.
- When a field is documented as optional, default to omission rather than inventing a value.
- When a field is documented as required, fail early with a clear local validation error.
- Preserve `0`-based `orderId` slot semantics exactly.

## Response handling rules

Implement strict response handling:

- If HTTP status is not `2xx`, parse and surface `{ "error": "..." }`.
- If a `2xx` body contains `{ "err": "..." }`, treat it as a compute failure and surface it separately.
- If the response contains `transactionBase64`, decode it as a versioned transaction and sign it client-side.
- If the response contains `receipt`, poll the receipt or resume the flow according to the documented guidance.
- Never treat a successful HTTP response as confirmed chain state unless the docs say it is confirmed.
- For basket and order reads, prefer the WebSocket or snapshot endpoints over rebuilding state from write responses.

## Error model

Map and display failures using the documented categories:

- validation / bad request
- not found
- rate limit / connection limit
- server / compute failure
- on-chain program error

Use the documented on-chain error codes and recovery guidance to decide whether to retry, rebuild, widen slippage, re-read state, or stop.

Common documented error cases the terminal must recognize:

- invalid pubkey / missing field / invalid enum -> validation failure
- unknown market / price / pool -> not found
- stale oracle / closed market -> retry later or re-query
- `owner == feePayer` on withdrawal -> reject locally
- `custodySettlementRequired: true` -> settle first
- blockhash expiry -> rebuild immediately
- basket not delegated -> delegate first
- insufficient balance / collateral / liquidity -> adjust size or wait
- TP/SL or limit validation failure -> validate direction and slot constraints
- `400` and `500` bodies may both occur; inspect both status and body

## Recovery rules

When a flow fails, recover only in the ways the docs explicitly support:

- wrong RPC -> send to the correct RPC
- basket not delegated -> delegate first
- insufficient collateral after deposit -> wait for the deposit to confirm and be credited
- `custodySettlementRequired: true` -> settle custody first, then retry withdrawal
- pending withdrawal -> resume with `withdrawal-settle`
- expired blockhash -> rebuild a fresh transaction and submit immediately
- stale or missing price -> wait or re-query
- position/order not reflected immediately -> re-read basket snapshot or WebSocket
- limit/trigger slot exhausted -> cancel or reuse available slot only after re-reading current order state
- stale oracle -> wait for the next valid price or switch to another market if the docs say the market is closed

Do not invent retries, backoffs, or state repair flows that are not documented.

## Trading quality bar

Implement the terminal as if it will be used in production on real capital:

- deterministic state transitions
- precise typed errors
- no duplicate signing paths
- no silent fallback from a documented failure into an undocumented one
- no ambiguous command parsing
- no hidden retries that could change economic outcome
- no synthetic market data
- no guessing around collateral, leverage, or liquidation math

## Referral and builder code

The docs state that partner referral attribution is supported through the documented `referralAccount` request field.

Rules:

- pass referral data only through documented fields
- do not invent additional attribution parameters
- if referral behavior is not enabled or documented for a code path, do not fake it
- if a partner builder code is needed later, source the exact wiring from the docs before implementation

## Output standard

Every implementation should produce:

- a concise production terminal experience
- exact doc-aligned behavior
- explicit error messages
- no hidden assumptions
- no unsupported shortcuts

If you are uncertain at any point, stop and verify against the docs rather than improvising.
