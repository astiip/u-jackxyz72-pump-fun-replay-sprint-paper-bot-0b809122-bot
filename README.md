# u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/astiip/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/astiip/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

**Curve Rider** — a trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. Best net PnL wins.

## Idea

A bonding curve's price is a deterministic function of the real SOL in it — price from create is `((30 + rq) / 30)^2` — so only fresh SOL moves price. Most coins that reach 10 SOL stall and bleed, but the ones that get there **on a burst** (real SOL up ≥ 20 in the last 100 slots) complete far more often: 49% of that cohort in the dev window, against 10% of the plain rq ≥ 10 cohort. The bot buys exactly one burst per coin, then rides it with a partial take-profit at +75%, a 25% trailing stop, and a wide −35% hard stop.

A position can die −80% inside one slot (a mass sell-off drains the curve before the bot gets another batch), so no stop can save a full position — the defence is banking half the win early, the trailing stop, and a small 0.25 SOL stake.

## Dev-window result (local grade)

- **Net PnL: +1.43 SOL** on 10 SOL capital (+14.3%)
- 33 round trips over 33 coins, 60.6% wins, max drawdown 4.9%
- Net ex-top-3 coins: +0.76 SOL; both halves of the window positive (+0.56 / +0.87 SOL)
- Still positive at 2x fees

See [STRATEGY.md](STRATEGY.md) for the full numbers and robustness checks.

## Layout

- `main.ts` — entrypoint the grader runs (`node /bot/main.ts`)
- `strategy.ts` — the strategy (entry filter, exits, position tracking)
- `vendor/makefun-bot.ts` — the kit's replay SDK shim, vendored byte for byte
- `STRATEGY.md` — how the edge was measured and why the parameters are what they are
