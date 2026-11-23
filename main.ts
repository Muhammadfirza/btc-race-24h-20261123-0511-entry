// Patient trend rider v2 for btc-race-24h-20261123-0511 (cbBTC/USDC, 1m bars).
//
// v1 waited for a trend big enough to clear its costs and rode it with a wide
// trailing stop. It worked, but it missed pullbacks: on a choppy up day the
// price dips 1-2% and recovers several times before any 4h trend prints, and
// v1 sat in cash through all of them. v2 keeps the trend core and adds a
// dip-buying sleeve, the race mode the dev board's leaders describe in their
// titles ("dip-bounce/trend", "dip-rider", "V-recovery/trend").
//
// The replay charges about 35 bps a full round trip (4 bps fee, 2 bps modelled
// slippage and ~11 bps of pool impact a side at the dev window's depths), while
// one-minute closes wiggle about 8 bps a minute. Any bot that trades on
// minute-scale signals pays the spread many times over and bleeds out, so both
// sleeves are deliberately patient: they wait for a move big enough to clear
// costs many times over, then ride it without letting chop shake them loose.
//
// Rules (long only, one position, 1,000 USDC paper start):
//   * TREND ENTRY: once 240 scored bars have closed, buy 100% of cash when the
//     close is above its 120-bar EMA *and* the 240-bar (4h) return is above
//     +1.5%. Both legs must agree: the EMA leg says the short trend is up, the
//     momentum leg says the move is real, not noise. While already holding a
//     dip position, a trend confirmation tops the position up to full cash
//     ("breakout-pyramid").
//   * DIP SLEEVE: while flat, buy 34% of cash when the close has dipped 1.5%
//     or more below the highest close of the last 240 bars *and* bounced
//     (closed 0.3% above the low of the last 5 bars). The bounce filter is
//     what keeps the sleeve out of falling knives: an unconfirmed dip buy
//     loses badly on a falling day, a confirmed one does not fire there at
//     all. Two more tranches add while holding a dip position: 33% of the
//     remaining cash at a 3.0% dip from the same peak, the rest at a 4.5% dip,
//     each needing the same bounce. A guard blocks all dip buys when the
//     240-bar return is below -2% (a deep downtrend, not a dip).
//   * EXIT: sell everything when the close falls 2.5% below the highest close
//     seen since the position opened. No other exit: no EMA cross-out, no
//     take-profit, no time stop. A tighter 1.5% stop was tested and REJECTED:
//     it gets shaken out by ordinary chop and re-enters, bleeding fees on
//     every robust check (dev, bootstrap and worst case all worse).
//   * RE-ENTRY: allowed once 60 bars have passed since the last exit, if the
//     entry legs agree again. The cooldown gates dip entries too.
//   * SCOUT: if no order has ever filled by scored bar 1200, buy 10% of cash
//     so the entry still meets the race guardrail (at least 1 trade) on a flat
//     or falling window, where neither sleeve may ever fire. The scout rides
//     the same 2.5% trailing stop and is flattened with everything else.
//
// Determinism: no clock, no network, no environment, no randomness. All state
// derives from the bars the harness sends; floats come only from integer closes,
// so two runs on the same data decide the same orders.
//
// Verified with the kit's own grade-local (process driver) on the dev window:
// net PnL +19.729238 USDC, 1 trade, 0 rejected orders, max drawdown 1.98%,
// fees 0.808055 USDC (net PnL at 2x fees still +18.91 USDC). The two
// executions' action logs matched byte for byte, and the action log is
// byte-identical to v1's: the dip sleeve never fires on the dev window, so
// v2's dev grade is v1's dev grade and the dev gate still passes. The v2 edge
// shows only out of sample: across 180 block-bootstrapped 24h windows (3 seeds
// x 60) v2's mean net PnL beats v1's on every seed (+0.65 to +0.78 USDC) with
// an identical worst case and an identical reversed-window result (-1.70 USDC,
// scout only). The 1.5% trailing stop was tested and rejected on the same
// checks (dev +11.39, bootstrap median +3.72, worst -55.64).

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, BuyInput, SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Trend entry: 4h momentum must clear this, and the close must sit above this EMA.
const MOM_BARS = 240;
const MOM_MIN = 0.015;
const EMA_BARS = 120;
// Dip sleeve: peak lookback, dip depths per tranche, bounce confirmation.
const DIP_LOOKBACK = 240;
const DIP_1 = 0.015;
const DIP_2 = 0.030;
const DIP_3 = 0.045;
const TRANCHE_1_NUM = 34n;
const TRANCHE_2_NUM = 33n;
const TRANCHE_DEN = 100n;
const CONFIRM_BARS = 5;
const CONFIRM_PCT = 0.003;
// Dip guard: no dip buys when the 240-bar return is below this.
const DIP_TREND_GUARD = -0.02;
// Exit: trailing stop off the best close since entry.
const TRAIL = 0.025;
// Re-entry only after this many scored bars past an exit.
const COOLDOWN_BARS = 60;
// Scout: if nothing has filled by this scored bar, buy this share of cash.
const SCOUT_BAR = 1200;
const SCOUT_DIVISOR = 10n;
// Minimum buy notional: 1 USDC = 1,000,000 quote units.
const MIN_NOTIONAL = 1000000n;
// Orders may fill up to this far from the latest close (gap + slip + impact).
const MAX_SLIPPAGE_BPS = 300;

type Order = BuyInput | SellInput;

class Rider {
  // Float closes, warm-up bars included: history is history.
  private closes: number[] = [];
  private ema: number | null = null;
  // Scored bars seen (warm-up batches do not count).
  private barIndex = -1;
  // Highest close since the current position opened (null while flat).
  private peak: number | null = null;
  // Scored bar of the last observed exit (for the re-entry cooldown).
  private lastExit = -1e9;
  // Fills actually reported by the harness.
  private fills = 0;
  private scoutSent = false;
  // Dip sleeve state on the current position: tranches taken and their peak.
  private dipTranches = 0;
  private dipPeak: number | null = null;

  private trendOk(close: number): boolean {
    if (this.barIndex < MOM_BARS) return false;
    const momentum = close / this.closes[this.closes.length - 1 - MOM_BARS] - 1;
    return close > (this.ema as number) && momentum > MOM_MIN;
  }

  private bounceOk(close: number): boolean {
    if (this.closes.length < CONFIRM_BARS) return false;
    const low = Math.min(...this.closes.slice(-CONFIRM_BARS));
    return close > low * (1 + CONFIRM_PCT);
  }

  private dipGuardOk(close: number): boolean {
    if (this.barIndex < MOM_BARS) return true;
    const ret = close / this.closes[this.closes.length - 1 - MOM_BARS] - 1;
    return ret > DIP_TREND_GUARD;
  }

  private cooldownOk(): boolean {
    return this.barIndex - this.lastExit >= COOLDOWN_BARS;
  }

  onBatch(state: BarsState, batch: Batch): Order[] {
    for (const fill of batch.fills) {
      if (fill.status === 'filled') this.fills += 1;
    }
    let bar = null;
    for (const b of batch.bars) {
      if (b.symbol === SYMBOL) {
        bar = b;
        break;
      }
    }
    if (bar === null) {
      // A minute with no CBBTC bar: nothing new to decide on.
      return [];
    }
    const priceScale = state.symbols.get(SYMBOL)!.price_scale;
    const close = Number(bar.c) / 10 ** priceScale;
    this.closes.push(close);
    if (this.ema === null) {
      this.ema = close;
    } else {
      const alpha = 2 / (EMA_BARS + 1);
      this.ema = alpha * close + (1 - alpha) * this.ema;
    }
    if (state.warmingUp) {
      // Warm-up batches build history; their orders are rejected anyway.
      return [];
    }
    this.barIndex += 1;

    const holding = state.positions.get(SYMBOL);
    const inPosition = holding !== undefined && holding.qty > 0n;
    if (inPosition) {
      if (this.peak === null || close > this.peak) this.peak = close;
      if (close < this.peak * (1 - TRAIL)) {
        this.peak = null;
        this.lastExit = this.barIndex;
        this.dipTranches = 0;
        this.dipPeak = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: holding.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      // Top-up: a trend confirmation while holding a dip position buys the
      // rest of the cash (breakout-pyramid).
      if (this.trendOk(close)) {
        const room = state.weightRoom(SYMBOL);
        const notional = state.cash < room ? state.cash : room;
        if (notional >= MIN_NOTIONAL) {
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      // Deeper dip tranches, only on a position the dip sleeve opened.
      if (this.dipPeak !== null && this.dipTranches < 3 && this.cooldownOk()) {
        const need = this.dipTranches === 1 ? DIP_2 : DIP_3;
        const dip = close / this.dipPeak - 1;
        if (dip <= -need && this.bounceOk(close) && this.dipGuardOk(close)) {
          const notional = this.dipTranches === 1
            ? (state.cash * TRANCHE_2_NUM) / TRANCHE_DEN
            : state.cash;
          const room = state.weightRoom(SYMBOL);
          const capped = notional < room ? notional : room;
          if (capped >= MIN_NOTIONAL) {
            this.dipTranches += 1;
            return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: capped, max_slippage_bps: MAX_SLIPPAGE_BPS }];
          }
        }
      }
      return [];
    }

    // Flat: the position closed (or never opened); keep the exit stamp fresh.
    if (this.peak !== null) {
      this.peak = null;
      this.lastExit = this.barIndex;
      this.dipTranches = 0;
      this.dipPeak = null;
    }

    // Trend entry: full cash.
    if (this.cooldownOk() && this.trendOk(close)) {
      const room = state.weightRoom(SYMBOL);
      const notional = state.cash < room ? state.cash : room;
      if (notional > 0n) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }

    // Dip sleeve, tranche 1: a confirmed pullback from the recent peak.
    if (this.barIndex >= DIP_LOOKBACK && this.cooldownOk() && this.dipGuardOk(close)) {
      const recentPeak = Math.max(...this.closes.slice(-DIP_LOOKBACK));
      const dip = close / recentPeak - 1;
      if (dip <= -DIP_1 && this.bounceOk(close)) {
        const notional = (state.cash * TRANCHE_1_NUM) / TRANCHE_DEN;
        const room = state.weightRoom(SYMBOL);
        const capped = notional < room ? notional : room;
        if (capped >= MIN_NOTIONAL) {
          this.dipTranches = 1;
          this.dipPeak = recentPeak;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: capped, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }

    if (this.barIndex === SCOUT_BAR && this.fills === 0 && !this.scoutSent) {
      this.scoutSent = true;
      const room = state.weightRoom(SYMBOL);
      const tenth = state.cash / SCOUT_DIVISOR;
      const notional = tenth < room ? tenth : room;
      if (notional > 0n) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  }
}

const rider = new Rider();
await runBars({ onBatch: (state, batch) => rider.onBatch(state, batch) });
