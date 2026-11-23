# Patient Trend Rider — btc-race-24h-20261123-0511

A bot that trades cbBTC/USDC on 1-minute on-chain prices for the make.fun
24-hour BTC race. Long only, no leverage, $1,000 paper start.

## Why patient

A full round trip in this replay costs about 35 bps (4 bps fee, 2 bps
modelled slippage, ~11 bps of pool impact per side at the dev window's
depths), while one-minute closes move about 8 bps a minute. Trading on
minute-scale signals pays the spread many times over: in local replay, an
EMA-crossover bot lost $22.56 and a 60-bar momentum bot lost $30.77 on the
dev window, while buy-and-hold made $32.17. The edge here is not frequency —
it is waiting for a move big enough to clear costs many times over, then
riding it without letting chop shake the position loose.

## Strategy

- **Entry.** Once 240 scored bars have closed, buy 100% of cash when the
  close is above its 120-bar EMA **and** the 240-bar (4h) return is above
  +1.5%. Both legs must agree.
- **Exit.** Sell everything when the close falls 2.5% below the highest
  close since entry. No other exit: no EMA cross-out, no take-profit, no
  time stop.
- **Re-entry.** Allowed 60 bars after an exit, if the entry legs agree again.
- **Scout.** If no order has ever filled by scored bar 1200, buy 10% of
  cash so the entry still meets the race guardrail (at least 1 trade) on a
  flat or falling window, where the main entry may never fire. The scout
  rides the same 2.5% trailing stop.

## Verified results

Kit `grade-local` (process driver) on the published 24h dev window, commit
`9c586e4` (the revision after it only touches comments and this file):

| | |
|---|---|
| Net PnL | **+19.729238 USDC** (dev gate: above 0 — passes) |
| Trades | 1 (buy once, hold to the end) |
| Rejected orders | 0 |
| Max drawdown | 1.98% (guardrail: ≤ 25%) |
| Fees | 0.808055 USDC; net PnL at 2x fees +18.91 USDC |
| Determinism | two executions' action logs matched byte for byte |

Robustness was checked in a local replay before submitting, not by tuning on
the dev window alone:

- **Block bootstrap:** 60 synthetic 24h windows built by resampling 60-minute
  blocks of the dev window's returns — median net PnL +12.44 USDC, mean
  +21.65, win rate 81%, worst −27.93.
- **Reversed window:** the dev window run backwards (a −3.64% day) — the bot
  loses only 0.46 USDC, on the scout trade alone; the main entry never fires.
  Buy-and-hold loses 38.68 USDC on the same window.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only).
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte for byte.
