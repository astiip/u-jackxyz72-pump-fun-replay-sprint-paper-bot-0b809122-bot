# STRATEGY.md — Curve Rider

## The market, as measured

Dev window: frozen 24h of pump.fun bonding-curve events (2–3 Nov 2026), 1222
coins, 126,801 trades, 62,024 SOL volume. 35 coins completed (migrated); the
terminal price is always 14.7x the create price — a property of the curve.

Price on a pump.fun curve is a deterministic function of the real SOL in it:

```
price(rq) / price(create) = ((30 + rq) / 30)^2
```

so the only thing that can push a coin up is fresh SOL flowing in. Everything
else (price momentum, dip-buying, launch sniping) is a noisy proxy for flow,
and every one of those proxies lost money on this window when tested with
first-touch exits and the real 2-slot latency:

| approach | dev net PnL |
|---|---|
| momentum (buy +5% in 30 slots, hold up to 1500) | −9.66 SOL |
| mean reversion (buy 30–45% dip off 2500-slot high) | −4.08 SOL |
| launch sniper (buy age ≤ 3 slots, TP 15% / SL 12%) | −0.49 SOL |
| buy any coin at rq ≥ 10, ride with trail | −3.69 SOL |

## The burst filter

Of the 1222 coins, 358 reached rq ≥ 10 SOL and 35 of those completed (9.8%).
But the ones that reached rq ≥ 10 **on a burst** — real SOL up ≥ 20 over the
last 100 slots — completed 49% of the time (30 of 61). The burst is the
signal: it means a whale (or a crowd arriving together) is buying now, not
that the coin merely drifted up over hours. Slow coins (age ≥ 300 slots at
crossing) completed 0% of the time.

## Why exits matter more than entries

The first version of this bot (rq ≥ 10, trail 25%, SL 25%) lost −3.69 SOL
even though the Python analysis said +3.6 SOL. The gap: a position can die
−80% inside **one slot**. One real case: rq 60.4 → 3.05 in a single slot, ~50
distinct sellers, price −87%. No stop can save a full position against that —
the bot only acts between slots. The Python analysis had assumed stops fill
at the stop level; the replay fills them at the crashed price.

So the exits are built around that fact:

- **Partial take-profit**: sell half at +75% over cost. A death spiral can
  then only take what is left.
- **Trailing stop 25%**, armed at +25%: a position that ran up is mostly out
  before the spiral.
- **Hard stop −35%**, not tighter: the curve is noisy slot to slot and a
  tight stop just pays fees to the churn (SL 35% beat SL 25% and SL 50%).
- **Stake 0.25 SOL**: one death costs at most ~0.21 SOL; dev max drawdown
  4.9%, far from the 50% guardrail.

## Final parameters

| param | value |
|---|---|
| entryRqSol | 10 SOL |
| minGrowthSol | 20 SOL over growthWindow |
| growthWindow | 100 slots |
| stakeSol | 0.25 SOL |
| stopLoss | 0.35 |
| trailArm / trail | 0.25 / 0.25 |
| maxHold | 3000 slots |
| tpPart / tpPartAt | 0.5 / +0.75 |
| buy/sell slippage | 10000 bps |

## Dev-window result (local grade, full 24h)

- **Net PnL +1.43 SOL** (+14.3% on 10 SOL), 33 round trips / 33 coins,
  60.6% wins, max drawdown 0.049, 0 rejected orders, 3 failed txs.
- Net ex-top-3 coins: **+0.76 SOL** — the result does not lean on the best
  coins. Both halves of the window positive: +0.56 / +0.87 SOL.
- At 2x fees the net stays positive (~+0.9 SOL).

## Robustness (same local grade, neighbouring settings)

The edge is the burst filter, not a tuned peak — the whole neighbourhood is
positive:

- growth 18 / 20 / 22 SOL → +0.05 / +0.17 / +0.05 SOL (same exits, stake
  0.09); at the shipped stake the band stays positive too
- stop 30% / 35% / 40% → +0.79 / +0.96 / +0.84 SOL (stake 0.20)
- trail 20% / 25% / 30% → +1.03 / +0.96 / +0.97 SOL (stake 0.20)
- growthWindow 50 slots → −0.07 SOL (too noisy); 200 slots → +0.27 SOL
  (diluted). The 100-slot window matters: the burst must be sustained ~40s.
- growth 25+ SOL → negative: too few coins (20), the filter gets too strict.

## What could still go wrong on the final window

- The final window is fresh 24h data (27–28 Nov). The burst filter is
  structural (bonding-curve math + completion dynamics), but if the final
  window has far fewer whale bursts, the bot trades few coins — the guardrail
  needs ≥ 20 coins with ≥ 0.01 SOL round trips; the dev window gave 33.
- A death spiral can still take −80% of a position; the partial TP and the
  small stake bound that to ~0.10 SOL per coin.
- The bot never trades on a coin it has already entered once, even if it
  bursts again later — deliberate, to avoid chasing a stalled coin.
