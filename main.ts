// v3 — selective momentum bot (pump.fun paper sprint).
// Tighter than v2: fewer, stronger entries; smaller size; faster exits.
// Entry (30-slot window): >=8 distinct buyers, second-half buys > 2x
// first-half buys, price up 10-60%, age >= 500 slots, real reserve 2-60 SOL.
// Size: first buy 0.01 SOL, pyramid 0.05 SOL per batch to max 0.15 SOL
// per position, max 5 positions, 1.5 SOL total exposure.
// Exits: -5% stop-loss, trailing 0.9x peak (active above +5%),
// max hold 300 slots unless value >= 2x cost.
// One 0.01 SOL guardrail probe max, only if the pace is behind
// (<25 coins and <240 fills after ~14400s of slots) — keeps the
// >=20-coin guardrail reachable without spraying trades.
// Deterministic: no clock, no randomness, no env; only hello seed/state.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const WINDOW = 30;
const HALF = 15;
const MIN_BUYERS = 8;
const MIN_SECOND_HALF_BUYS = 4;
const RISE_MIN_NUM = 11n; // price >= 1.10x window-start price
const RISE_MIN_DEN = 10n;
const RISE_MAX_NUM = 16n; // price <= 1.60x window-start price
const RISE_MAX_DEN = 10n;
const MIN_AGE = 500;
const REAL_MIN = 2n * SOL;
const REAL_MAX = 60n * SOL;
const FIRST_BUY = SOL / 100n; // 0.01 SOL
const PYRAMID = SOL / 20n; // 0.05 SOL
const MAX_PER_POSITION = (SOL * 15n) / 100n; // 0.15 SOL
const MAX_POSITIONS = 5;
const MAX_EXPOSURE = (SOL * 3n) / 2n; // 1.5 SOL
const SLIPPAGE_BPS = 500;
const TX_FEE = 105000n; // base + priority fee per order, lamports
const CURVE_FEE_NUM = 9875n; // keep (1 - 1.25%) of the curve quote
const CURVE_FEE_DEN = 10000n;
const STOP_NUM = 95n; // sell when value < 95% of cost
const STOP_DEN = 100n;
const TRAIL_ACTIVATE_NUM = 105n; // trailing arms once peak >= 105% of cost
const TRAIL_ACTIVATE_DEN = 100n;
const TRAIL_NUM = 9n; // sell when value < 0.9x peak
const TRAIL_DEN = 10n;
const MAX_HOLD = 300;
const HOLD_KEEP_NUM = 2n; // keep past max hold only if value >= 2x cost
const PROBE_PACE_COINS = 25;
const PROBE_PACE_FILLS = 240;
const PROBE_PACE_SLOTS = 36000; // ~14400s at ~0.4s per slot
const PROBE_BUY = SOL / 100n; // 0.01 SOL
const PROBE_MIN_BUYERS = 4;
const PROBE_RISE_MIN_NUM = 105n; // relaxed probe: >= +5%
const PROBE_RISE_MIN_DEN = 100n;

interface Snap {
  slot: number;
  user: string;
  isBuy: boolean;
  vq: bigint;
  vt: bigint;
}

interface Track {
  createdSlot: number | null;
  snaps: Snap[];
  entrySlot: number;
  entryVq: bigint;
  entryVt: bigint;
  peak: bigint;
}

const tracks = new Map<string, Track>();
const boughtMints = new Set<string>();
const soldMints = new Set<string>();
let fillsSeen = 0;
let firstSlot = -1;
let probeUsed = false;

function trackFor(mint: string): Track {
  let t = tracks.get(mint);
  if (t === undefined) {
    t = { createdSlot: null, snaps: [], entrySlot: -1, entryVq: 0n, entryVt: 0n, peak: 0n };
    tracks.set(mint, t);
  }
  return t;
}

// priceNow / priceOld >= num/den, exact bigint cross-multiplication.
function priceAtLeast(vqN: bigint, vtN: bigint, vqO: bigint, vtO: bigint, num: bigint, den: bigint): boolean {
  return vqN * vtO * num >= vtN * vqO * den;
}

function priceAtMost(vqN: bigint, vtN: bigint, vqO: bigint, vtO: bigint, num: bigint, den: bigint): boolean {
  return vqN * vtO * num <= vtN * vqO * den;
}

// Value of `tokens` on this curve now, net of curve fee and one tx fee.
function positionValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vq <= 0n || vt <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const net = (gross * CURVE_FEE_NUM) / CURVE_FEE_DEN;
  return net > TX_FEE ? net - TX_FEE : 0n;
}

await runBot({
  onBatch(state, batch) {
    if (firstSlot < 0) firstSlot = batch.slot;
    const orders: (BuyInput | SellInput)[] = [];
    const slot = batch.slot;

    for (const f of batch.fills) {
      fillsSeen += 1;
      if (f.status === 'filled') {
        if (f.side === 'buy') boughtMints.add(f.mint);
        if (f.side === 'sell') soldMints.add(f.mint);
      }
    }

    // Fold this batch's events into per-mint 30-slot windows.
    const touched = new Set<string>();
    for (const e of batch.events) {
      const t = trackFor(e.mint);
      if (e.event === 'CreateEvent') {
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        t.snaps.push({
          slot: e.slot,
          user: e.user,
          isBuy: e.is_buy,
          vq: BigInt(e.virtual_quote_reserves),
          vt: BigInt(e.virtual_token_reserves),
        });
        touched.add(e.mint);
      }
    }
    // Prune snapshots older than the window.
    for (const mint of touched) {
      const t = tracks.get(mint);
      if (t === undefined) continue;
      const cutoff = slot - WINDOW;
      while (t.snaps.length > 0 && t.snaps[0].slot <= cutoff) t.snaps.shift();
    }

    const committed = state.committedPositionCount();
    let exposure = 0n;
    for (const p of state.positions.values()) exposure += p.cost_lamports;

    // --- exits first: stops, trailing, max hold ---
    const sells: { mint: string; tokens: bigint }[] = [];
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = trackFor(mint);
      const value = positionValueLamports(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (value > t.peak) t.peak = value;
      const cost = pos.cost_lamports;
      if (cost <= 0n) continue;
      const stopHit = value * STOP_DEN < cost * STOP_NUM;
      const trailArmed = t.peak * TRAIL_ACTIVATE_DEN >= cost * TRAIL_ACTIVATE_NUM;
      const trailHit = trailArmed && value * TRAIL_DEN < t.peak * TRAIL_NUM;
      const heldTooLong = t.entrySlot >= 0 && slot - t.entrySlot > MAX_HOLD && value < cost * HOLD_KEEP_NUM;
      if (stopHit || trailHit || heldTooLong) {
        sells.push({ mint, tokens: pos.token_amount });
      }
    }
    for (const s of sells) {
      if (orders.length >= 16) break;
      orders.push({ side: 'sell', mint: s.mint, token_amount: s.tokens, max_slippage_bps: SLIPPAGE_BPS });
    }

    // --- entries + pyramids on mints touched this batch ---
    const canOpen = committed + sells.length < MAX_POSITIONS;
    for (const mint of touched) {
      if (orders.length >= 16) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const t = tracks.get(mint);
      if (t === undefined || t.snaps.length === 0) continue;
      if (curve.created_slot === null || slot - curve.created_slot < MIN_AGE) continue;
      if (curve.real_quote_reserves < REAL_MIN || curve.real_quote_reserves > REAL_MAX) continue;

      const held = state.positions.get(mint);
      const pendingBuy = [...state.pending.values()].some((p) => p.order.side === 'buy' && p.order.mint === mint);

      // Window stats from the 30-slot snapshot list.
      const oldest = t.snaps[0];
      const latest = t.snaps[t.snaps.length - 1];
      if (slot - oldest.slot < 20) continue; // need most of the window covered
      const buyers = new Set<string>();
      let firstHalfBuys = 0;
      let secondHalfBuys = 0;
      for (const s of t.snaps) {
        if (!s.isBuy) continue;
        buyers.add(s.user);
        if (s.slot > slot - HALF) secondHalfBuys += 1;
        else firstHalfBuys += 1;
      }
      const rising = priceAtLeast(latest.vq, latest.vt, oldest.vq, oldest.vt, RISE_MIN_NUM, RISE_MIN_DEN)
        && priceAtMost(latest.vq, latest.vt, oldest.vq, oldest.vt, RISE_MAX_NUM, RISE_MAX_DEN);
      const accelerating = secondHalfBuys >= MIN_SECOND_HALF_BUYS && secondHalfBuys > 2 * firstHalfBuys;

      if (held !== undefined) {
        // Pyramid: still above entry AND momentum alive in this window,
        // with room under the per-position cap.
        const aboveEntry = t.entryVq > 0n && t.entryVt > 0n
          && priceAtLeast(curve.virtual_quote_reserves, curve.virtual_token_reserves, t.entryVq, t.entryVt, 102n, 100n);
        const stillRising = priceAtLeast(latest.vq, latest.vt, oldest.vq, oldest.vt, 105n, 100n)
          && priceAtMost(latest.vq, latest.vt, oldest.vq, oldest.vt, RISE_MAX_NUM, RISE_MAX_DEN);
        const room = MAX_PER_POSITION - held.cost_lamports;
        const free = state.freeCashLamports();
        if (!pendingBuy && aboveEntry && stillRising && room > 0n && exposure + PYRAMID <= MAX_EXPOSURE && free >= PYRAMID + TX_FEE) {
          const size = room < PYRAMID ? room : PYRAMID;
          if (size >= FIRST_BUY && state.maxBuyLamports(mint) >= size) {
            orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: SLIPPAGE_BPS });
            exposure += size;
          }
        }
        continue;
      }

      if (pendingBuy || !canOpen) continue;
      if (buyers.size < MIN_BUYERS || !rising || !accelerating) continue;
      const free = state.freeCashLamports();
      if (exposure + FIRST_BUY > MAX_EXPOSURE || free < FIRST_BUY + TX_FEE) continue;
      if (state.maxBuyLamports(mint) < FIRST_BUY) continue;
      t.entrySlot = slot;
      t.entryVq = curve.virtual_quote_reserves;
      t.entryVt = curve.virtual_token_reserves;
      t.peak = 0n;
      orders.push({ side: 'buy', mint, quote_lamports: FIRST_BUY, max_slippage_bps: SLIPPAGE_BPS });
      exposure += FIRST_BUY;
    }

    // --- guardrail probe: at most one, only when the pace is behind ---
    if (!probeUsed && committed === 0 && state.positions.size === 0 && slot - firstSlot >= PROBE_PACE_SLOTS) {
      const coinsDone = new Set([...boughtMints].filter((m) => soldMints.has(m))).size;
      if (coinsDone < PROBE_PACE_COINS && fillsSeen < PROBE_PACE_FILLS) {
        let best: string | null = null;
        let bestBuyers = 0;
        for (const [mint, t] of tracks) {
          if (orders.length >= 16) break;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (state.positions.has(mint) || boughtMints.has(mint)) continue;
          if (curve.created_slot === null || slot - curve.created_slot < MIN_AGE) continue;
          if (curve.real_quote_reserves < REAL_MIN || curve.real_quote_reserves > REAL_MAX) continue;
          if (t.snaps.length === 0 || slot - t.snaps[0].slot < 20) continue;
          const buyers = new Set<string>();
          for (const s of t.snaps) if (s.isBuy) buyers.add(s.user);
          const oldest = t.snaps[0];
          const latest = t.snaps[t.snaps.length - 1];
          const ok = buyers.size >= PROBE_MIN_BUYERS
            && priceAtLeast(latest.vq, latest.vt, oldest.vq, oldest.vt, PROBE_RISE_MIN_NUM, PROBE_RISE_MIN_DEN)
            && priceAtMost(latest.vq, latest.vt, oldest.vq, oldest.vt, RISE_MAX_NUM, RISE_MAX_DEN);
          if (ok && buyers.size > bestBuyers) {
            best = mint;
            bestBuyers = buyers.size;
          }
        }
        if (best !== null) {
          const curve = state.curves.get(best);
          const free = state.freeCashLamports();
          if (curve !== undefined && free >= PROBE_BUY + TX_FEE && state.maxBuyLamports(best) >= PROBE_BUY) {
            const t = trackFor(best);
            t.entrySlot = slot;
            t.entryVq = curve.virtual_quote_reserves;
            t.entryVt = curve.virtual_token_reserves;
            t.peak = 0n;
            orders.push({ side: 'buy', mint: best, quote_lamports: PROBE_BUY, max_slippage_bps: SLIPPAGE_BPS });
            probeUsed = true;
          }
        }
      }
    }

    return orders;
  },
});
