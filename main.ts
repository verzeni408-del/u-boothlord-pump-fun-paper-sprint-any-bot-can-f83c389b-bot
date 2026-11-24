// Momentum paper-trading bot for the pump.fun replay sprint.
// Strategy, written from the prose spec: ride 30-slot buying momentum on
// seasoned curves, pyramid only while the tape still accelerates, cut losers
// fast with a stop-loss and a trailing stop, and keep a slow probe running
// so the guardrail pace (coins traded / fills over time) never stalls.
//
// Deterministic by construction: every decision comes from the hello
// message and the batches the harness delivers. No clock, no randomness,
// no environment. Map iteration follows first-seen order, so two runs
// produce the same orders byte for byte.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL;
const FIRST_BUY = (SOL * 5n) / 100n; // 0.05 SOL
const PYRAMID_BUY = (SOL * 20n) / 100n; // 0.20 SOL per batch
const MAX_STAKE = SOL * 2n; // 2 SOL total per position
const MAX_EXPOSURE = SOL * 6n; // 6 SOL total across positions
const MIN_BUY = SOL / 100n; // 0.01 SOL
const PROBE_BUY = SOL / 100n; // 0.01 SOL guardrail probe
const WINDOW = 30; // entry window, slots
const PRUNE = WINDOW + 5; // keep trades this many slots back
const ENTRY_AGE = 500; // slots since CreateEvent
const COOLDOWN = 150; // slots after an exit before re-entry
const MAX_HOLD = 1500; // slots
const MAX_ENTRIES = 2; // fresh opens per mint
const BUY_SLIPPAGE = 1500;
const SELL_SLIPPAGE = 10000;
const PACE_SECONDS = 14400; // 4h: guardrail pace scales over this
const PACE_COINS = 25;
const PACE_FILLS = 240;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  firstSeen: number;
  trades: TapeTrade[];
}

interface PosInfo {
  entrySlot: number;
  peak: bigint;
  lastBuyPrice: number;
  entries: number;
  lastExitSlot: number;
}

interface WindowStats {
  buys: number;
  buyers: number;
  netInflow: bigint;
  firstPrice: number;
  high: number;
  firstHalf: bigint;
  secondHalf: bigint;
}

const tapes = new Map<string, Tape>();
const infos = new Map<string, PosInfo>();
const boughtMints = new Set<string>();
const roundTripMints = new Set<string>();
let fillsCount = 0;
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;
let probeMint: string | null = null;
let probeState: 'idle' | 'buying' | 'holding' | 'selling' = 'idle';
let probeSeq = 0;

function infoFor(mint: string, slot: number): PosInfo {
  let info = infos.get(mint);
  if (info === undefined) {
    info = { entrySlot: slot, peak: 0n, lastBuyPrice: 0, entries: 0, lastExitSlot: -1000000000 };
    infos.set(mint, info);
  }
  return info;
}

function priceOf(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vt = Number(curve.virtual_token_reserves);
  const vq = Number(curve.virtual_quote_reserves);
  if (vt <= 0 || vq <= 0) return 0;
  return vq / vt;
}

// Current value of a held position in lamports, net of the ~1.25%
// curve fee and one tx fee, per the spec formula.
function positionValueLamports(state: BotState, mint: string, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  const vt = curve.virtual_token_reserves;
  const vq = curve.virtual_quote_reserves;
  if (vt + tokens <= 0n) return 0n;
  const gross = (tokens * vq) / (vt + tokens);
  const net = (gross * 9875n) / 10000n;
  const value = net - state.txFeeLamports();
  return value > 0n ? value : 0n;
}

function windowStats(tape: Tape, nowSlot: number): WindowStats {
  const start = nowSlot - WINDOW;
  const mid = nowSlot - 15;
  let buys = 0;
  const buyers = new Set<string>();
  let netInflow = 0n;
  let firstPrice = 0;
  let high = 0;
  let firstHalf = 0n;
  let secondHalf = 0n;
  for (const t of tape.trades) {
    if (t.slot <= start) continue;
    if (t.price > high) high = t.price;
    if (firstPrice === 0) firstPrice = t.price;
    if (t.buy) {
      buys += 1;
      buyers.add(t.user);
      netInflow += t.sol;
      if (t.slot < mid) firstHalf += t.sol;
      else secondHalf += t.sol;
    } else {
      netInflow -= t.sol;
      if (t.slot < mid) firstHalf -= t.sol;
      else secondHalf -= t.sol;
    }
  }
  return { buys, buyers: buyers.size, netInflow, firstPrice, high, firstHalf, secondHalf };
}

function totalExposure(state: BotState): bigint {
  let sum = 0n;
  for (const pos of state.positions.values()) sum += pos.cost_lamports;
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy') sum += BigInt(p.order.quote_lamports);
  }
  return sum;
}

function hasPendingBuy(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

function hasPendingSell(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell' && p.order.mint === mint) return true;
  }
  return false;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const soldThisBatch = new Set<string>();
    const nowSlot = batch.slot;
    const txFee = state.txFeeLamports();
    let cashRoom = state.freeCashLamports();
    let exposureRoom = MAX_EXPOSURE - totalExposure(state);
    let buysSent = 0;

    const pushBuy = (mint: string, size: bigint, clientId?: string): boolean => {
      if (orders.length >= 16) return false;
      if (size < MIN_BUY) return false;
      if (size + txFee > cashRoom) return false;
      if (size > exposureRoom) return false;
      const order: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: size,
        max_slippage_bps: BUY_SLIPPAGE,
      };
      if (clientId !== undefined) order.client_id = clientId;
      orders.push(order);
      cashRoom -= size + txFee;
      exposureRoom -= size;
      buysSent += 1;
      return true;
    };

    const pushSellAll = (mint: string, tokens: bigint): boolean => {
      if (orders.length >= 16) return false;
      if (tokens <= 0n) return false;
      if (txFee > cashRoom) return false;
      const order: SellInput = {
        side: 'sell',
        mint,
        token_amount: tokens,
        max_slippage_bps: SELL_SLIPPAGE,
      };
      orders.push(order);
      cashRoom -= txFee;
      soldThisBatch.add(mint);
      return true;
    };

    // (1) Process fills: count them, track round trips and probe state.
    for (const fill of batch.fills) {
      const isProbe = fill.client_id.startsWith('probe');
      if (fill.status === 'filled') {
        fillsCount += 1;
        if (fill.side === 'buy') {
          boughtMints.add(fill.mint);
          if (isProbe) {
            probeMint = fill.mint;
            probeState = 'holding';
          }
          const info = infoFor(fill.mint, nowSlot);
          const price = priceOf(state, fill.mint);
          if (price > 0) info.lastBuyPrice = price;
        } else {
          if (boughtMints.has(fill.mint)) roundTripMints.add(fill.mint);
          if (isProbe) {
            probeMint = null;
            probeState = 'idle';
          }
          if (!state.positions.has(fill.mint)) {
            infoFor(fill.mint, nowSlot).lastExitSlot = nowSlot;
          }
        }
      } else if (isProbe) {
        // A probe order that did not fill frees the probe slot.
        if (fill.side === 'buy') {
          probeMint = null;
          probeState = 'idle';
        } else if (fill.side === 'sell') {
          probeState = 'holding';
        }
      }
    }

    // (2) Update the tape from this batch's events, and track pace time.
    const touched = new Set<string>();
    const tradedThisBatch: string[] = [];
    for (const event of batch.events) {
      if (event.block_time !== null && event.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = event.block_time;
        if (lastBlockTime === null || event.block_time > lastBlockTime) {
          lastBlockTime = event.block_time;
        }
      }
      if (event.event === 'CreateEvent') {
        let tape = tapes.get(event.mint);
        if (tape === undefined) {
          tape = { created: event.slot, firstSeen: event.slot, trades: [] };
          tapes.set(event.mint, tape);
        } else if (tape.created === null) {
          tape.created = event.slot;
        }
        touched.add(event.mint);
      } else if (event.event === 'TradeEvent') {
        let tape = tapes.get(event.mint);
        if (tape === undefined) {
          tape = { created: null, firstSeen: event.slot, trades: [] };
          tapes.set(event.mint, tape);
        }
        const vt = Number(BigInt(event.virtual_token_reserves));
        const vq = Number(BigInt(event.virtual_quote_reserves));
        tape.trades.push({
          slot: event.slot,
          buy: event.is_buy,
          sol: BigInt(event.sol_amount),
          user: event.user,
          price: vt > 0 && vq > 0 ? vq / vt : 0,
        });
        touched.add(event.mint);
        if (!tradedThisBatch.includes(event.mint)) tradedThisBatch.push(event.mint);
      } else {
        touched.add(event.mint);
      }
    }
    // Prune trades older than the window plus a small margin.
    const pruneCutoff = nowSlot - PRUNE;
    for (const mint of touched) {
      const tape = tapes.get(mint);
      if (tape === undefined) continue;
      while (tape.trades.length > 0 && tape.trades[0].slot <= pruneCutoff) {
        tape.trades.shift();
      }
    }
    for (const mint of state.positions.keys()) {
      const tape = tapes.get(mint);
      if (tape === undefined) continue;
      while (tape.trades.length > 0 && tape.trades[0].slot <= pruneCutoff) {
        tape.trades.shift();
      }
    }

    // (3) Exits first: stop-loss, trailing stop, max hold.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= 16) break;
      if (probeMint === mint && probeState !== 'idle') continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (hasPendingSell(state, mint)) continue;
      const info = infoFor(mint, nowSlot);
      const value = positionValueLamports(state, mint, pos.token_amount);
      const cost = pos.cost_lamports;
      if (value > info.peak) info.peak = value;
      const stopLoss = value < (cost * 8n) / 10n;
      const trailing =
        info.peak >= (cost * 105n) / 100n && value < (info.peak * 7n) / 10n;
      const maxHold =
        nowSlot - info.entrySlot > MAX_HOLD && value < cost * 2n;
      if (stopLoss || trailing || maxHold) {
        if (pushSellAll(mint, pos.token_amount)) {
          info.lastExitSlot = nowSlot;
        }
      }
    }

    // (4) Entries and pyramids, only on mints traded in this batch.
    for (const mint of tradedThisBatch) {
      if (orders.length >= 16) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const tape = tapes.get(mint);
      if (tape === undefined) continue;
      const pos = state.positions.get(mint);
      const info = infoFor(mint, nowSlot);
      const price = priceOf(state, mint);
      if (price <= 0) continue;

      if (pos !== undefined || hasPendingBuy(state, mint)) {
        // Pyramid: add while the last buy is still in profit territory,
        // the window inflow is not negative, and value covers cost.
        if (pos === undefined) continue;
        if (pos.cost_lamports >= MAX_STAKE) continue;
        if (price < info.lastBuyPrice) continue;
        const stats = windowStats(tape, nowSlot);
        if (stats.netInflow < 0n) continue;
        const value = positionValueLamports(state, mint, pos.token_amount);
        if (value < pos.cost_lamports) continue;
        const cap = state.maxBuyLamports(mint);
        let size = PYRAMID_BUY;
        const room = MAX_STAKE - pos.cost_lamports;
        if (size > room) size = room;
        if (size > cap) size = cap;
        if (size > exposureRoom) size = exposureRoom;
        if (size > cashRoom - txFee) size = cashRoom - txFee;
        if (size >= MIN_BUY) pushBuy(mint, size);
        continue;
      }

      // Fresh entry: momentum signal on the 30-slot window.
      if (info.entries >= MAX_ENTRIES) continue;
      if (nowSlot - info.lastExitSlot < COOLDOWN) continue;
      const created = curve.created_slot ?? tape.created ?? tape.firstSeen;
      if (nowSlot - created < ENTRY_AGE) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < SOL * 2n || realSol > SOL * 60n) continue;
      if (state.committedPositionCount() + buysSent >= 5) continue;
      const stats = windowStats(tape, nowSlot);
      if (stats.buys < 3) continue;
      if (stats.buyers < 5) continue;
      if (stats.netInflow < SOL) continue;
      if (stats.firstPrice <= 0) continue;
      const rise = (price - stats.firstPrice) / stats.firstPrice;
      if (rise < 0.05 || rise > 1.5) continue;
      if (price < stats.high * 0.95) continue;
      if (stats.secondHalf <= stats.firstHalf) continue;
      const cap = state.maxBuyLamports(mint);
      let size = FIRST_BUY;
      if (size > cap) size = cap;
      if (size > exposureRoom) size = exposureRoom;
      if (size > cashRoom - txFee) size = cashRoom - txFee;
      if (size >= MIN_BUY) {
        if (pushBuy(mint, size)) {
          info.entries += 1;
          info.entrySlot = nowSlot;
          info.peak = 0n;
          info.lastBuyPrice = price;
        }
      }
    }

    // (5) Guardrail probe: keep the coin/fill pace on schedule.
    if (probeState === 'holding' && probeMint !== null) {
      const pos = state.positions.get(probeMint);
      if (pos !== undefined && !soldThisBatch.has(probeMint)) {
        if (pushSellAll(probeMint, pos.token_amount)) {
          probeState = 'selling';
        }
      } else if (pos === undefined) {
        probeMint = null;
        probeState = 'idle';
      }
    } else if (probeState === 'idle' && orders.length < 16) {
      let behind = false;
      if (firstBlockTime !== null && lastBlockTime !== null) {
        const elapsed = lastBlockTime - firstBlockTime;
        if (elapsed > 0) {
          const expectCoins = (PACE_COINS * elapsed) / PACE_SECONDS;
          const expectFills = (PACE_FILLS * elapsed) / PACE_SECONDS;
          behind =
            roundTripMints.size < expectCoins || fillsCount < expectFills;
        }
      }
      if (behind) {
        for (const [mint, curve] of state.curves) {
          if (orders.length >= 16) break;
          if (curve.complete) continue;
          if (state.positions.has(mint)) continue;
          if (hasPendingBuy(state, mint)) continue;
          if (curve.real_quote_reserves < (SOL * 3n) / 2n) continue;
          if (curve.trades <= 0) continue;
          // Prefer a curve traded recently: a probe on a dead curve
          // wastes its tx fee and never fills near the decision price.
          const probeTape = tapes.get(mint);
          if (probeTape === undefined || probeTape.trades.length === 0) continue;
          const lastTrade = probeTape.trades[probeTape.trades.length - 1];
          if (nowSlot - lastTrade.slot > 600) continue;
          const cap = state.maxBuyLamports(mint);
          let size = PROBE_BUY;
          if (size > cap) size = cap;
          if (size > cashRoom - txFee) size = cashRoom - txFee;
          if (size < MIN_BUY) continue;
          probeSeq += 1;
          if (pushBuy(mint, size, `probe${probeSeq}`)) {
            probeMint = mint;
            probeState = 'buying';
          }
          break;
        }
      }
    }

    return orders;
  },
});
