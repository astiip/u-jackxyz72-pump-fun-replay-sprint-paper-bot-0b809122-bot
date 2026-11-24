// Curve Rider — a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// Thesis (measured on the dev window, not assumed): a bonding curve's price is a
// deterministic function of the real SOL sitting in it — price ratio from create
// is ((30 + rq) / 30)^2 — so the only thing that can push a coin up is fresh SOL
// flowing in. Most coins that reach rq = 10 SOL stall and bleed out, but the
// ones that get there on a burst — real SOL up >= 20 in the last 100 slots —
// complete far more often: 49% of that cohort in the dev window, against 10%
// of the plain rq >= 10 cohort. So the bot buys exactly one burst: the first
// batch where a curve's real SOL jumped >= 20 over the last 100 slots.
//
// A position can die -80% inside ONE slot — a mass sell-off drains the curve
// before the bot gets another batch — so no stop can save a full position. The
// defence is (a) bank half the win early with a partial take-profit at +75%,
// (b) a trailing stop so a position that ran up is already mostly out before
// the spiral, (c) a wide hard stop (-35%: tight stops just pay fees to the
// curve's slot-to-slot noise), and (d) a 0.25 SOL stake so one death cannot
// move the drawdown guardrail (dev max drawdown 4.9%).
//
// Dev window (frozen 24h, 1222 coins), local grade: net +1.43 SOL on 10 SOL
// capital, 33 round trips over 33 coins, 60.6% wins, max drawdown 0.049. The
// result does not lean on the best coins: net ex-top-3 is +0.76 SOL, and both
// halves of the window are positive (+0.56 / +0.87). At 2x fees the net stays
// positive. Neighbouring settings (growth 18-22, stop 30-40%, trail 20-30%)
// are all positive too — the edge is the burst filter, not a tuned peak.
// See STRATEGY.md for the numbers.
//
// Deterministic by construction: no clock, no randomness, no I/O; iteration only
// over insertion-ordered maps fed by the batch stream. The bot answers every
// batch with a reply (possibly empty orders) and echoes the batch seq.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Buy the first time a curve's real SOL reserve reaches this (SOL). */
  entryRqSol: number;
  /** Real SOL the curve must have gained over the growth window to count as a burst. */
  minGrowthSol: number;
  /** Lookback (slots) for the growth check. */
  growthWindow: number;
  /** SOL per entry (also capped by the 1%-of-real-reserve reply cap). */
  stakeSol: number;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuySol: number;
  /** Slippage tolerance on buys and sells (bps). */
  buySlipBps: number;
  sellSlipBps: number;
  /** Exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** The trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Once armed, exit when value falls this far below its peak. */
  trail: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Most positions open at once (<= caps.max_open_positions). */
  maxOpen: number;
  /** Sell this share of the position once value reaches cost * (1 + tpPartAt). 0 = off. */
  tpPart: number;
  /** Take-profit level for the partial sale (fraction over cost). */
  tpPartAt: number;
}

export const DEFAULT_PARAMS: Params = {
  entryRqSol: 10,
  minGrowthSol: 20,
  growthWindow: 100,
  stakeSol: 0.25,
  minBuySol: 0.01,
  buySlipBps: 10_000,
  sellSlipBps: 10_000,
  stopLoss: 0.35,
  trailArm: 0.25,
  trail: 0.25,
  maxHold: 3000,
  maxOpen: 5,
  tpPart: 0.5,
  tpPartAt: 0.75,
};

const LAMPORTS = 1e9;
/** Curve fees: protocol 95 bps + creator 30 bps, as the hello fees fall back to. */
const CURVE_FEE = 0.0125;

interface RqPoint {
  slot: number;
  rq: number;
}

interface Tape {
  /** Real SOL samples, oldest first, pruned to the growth window plus slack. */
  rq: RqPoint[];
  entered: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL spent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  filled: boolean;
  /** The partial take-profit was taken. */
  tookTp: boolean;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellQuote(tokens: number, vq: number, vt: number): number {
  if (tokens <= 0 || vt <= 0) return 0;
  return (tokens * vq) / (vt + tokens);
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { rq: [], entered: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Real SOL gained over the last `growthWindow` slots (0 when too young). */
  const growth = (t: Tape, now: number): number => {
    const pts = t.rq;
    if (pts.length === 0) return 0;
    const last = pts[pts.length - 1]!;
    let old = pts[0]!;
    for (let i = pts.length - 1; i >= 0; i--) {
      if (pts[i]!.slot <= now - p.growthWindow) {
        old = pts[i]!;
        break;
      }
    }
    return last.rq - old.rq;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const rq = Number(e.real_quote_reserves) / LAMPORTS;
          const pts = t.rq;
          if (pts.length === 0 || pts[pts.length - 1]!.slot < e.slot) pts.push({ slot: e.slot, rq });
          else pts[pts.length - 1]!.rq = rq;
          let cut = 0;
          while (cut < pts.length && pts[cut]!.slot <= now - p.growthWindow - 10) cut++;
          if (cut > 0) pts.splice(0, cut);
          touched.add(e.mint);
        } else if (e.event === 'CreateEvent') {
          tapeOf(e.mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first. A position is sold whole on the first of a hard stop, a
      // trailing stop from its best liquidation value, or the time limit; before
      // that, the partial take-profit banks a share of the win early, so a
      // one-slot death spiral can only take what is left.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = sellQuote(tokens, vq, vt) / LAMPORTS * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        // Partial take-profit: bank tpPart of the tokens once the position is
        // up tpPartAt over cost. One shot; the rest keeps riding.
        if (!h.tookTp && p.tpPart > 0 && value >= cost * (1 + p.tpPartAt)) {
          const part = BigInt(Math.floor(tokens * p.tpPart));
          if (part > 0n && orders.length < cap) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: p.sellSlipBps });
            h.tookTp = true;
            // The harness cuts the position's cost pro-rata on the fill; scale
            // the peak the same way now, or the trailing stop would fire on the
            // smaller remainder at once.
            h.peakValue = h.peakValue * (1 - p.tpPart);
            continue;
          }
        }
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // Entries: the first batch where a curve's real SOL is at or above the
      // entry line and jumped by at least minGrowthSol over the growth window.
      // One entry per coin, ever.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = Math.min(p.maxOpen, state.hello.caps.max_open_positions) - state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || held.has(mint) || state.positions.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entered) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.entryRqSol) continue;
        if (growth(t, now) < p.minGrowthSol) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        slotsLeft--;
        t.entered = true;
        held.set(mint, { opened: now, peakValue: 0, invested: amount, exiting: false, filled: false, tookTp: false });
      }
      return orders;
    },
  };
}
