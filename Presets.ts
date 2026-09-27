export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
  n: number; // antal ticks i ljuset
}
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Bygger en trovärdig historik som slutar exakt på `center`. */
export function seedCandles(
  center: number,
  relVol: number,
  count = 68,
  seed = 1337
): Candle[] {
  const rnd = mulberry32(seed);
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) / 2;
  const out: Candle[] = [];
  let price = center;
  let trend = (rnd() - 0.5) * relVol * 0.6;
  for (let i = 0; i < count; i++) {
    if (i % 11 === 0) trend = (rnd() - 0.5) * relVol * 0.9;
    const o = price;
    const c = o * (1 + trend + gauss() * relVol);
    const h = Math.max(o, c) * (1 + rnd() * relVol * 0.55);
    const l = Math.min(o, c) * (1 - rnd() * relVol * 0.55);
    out.push({ o, h, l, c, n: 7 });
    price = c;
  }
  const k = center / out[out.length - 1].c;
  return out.map((c) => ({ o: c.o * k, h: c.h * k, l: c.l * k, c: c.c * k, n: c.n }));
}
export interface Drift {
  v: number;
}
/** Uppdaterar sista ljuset och rullar serien vidare. */
export function tickCandles(
  candles: Candle[],
  vol: number,
  rnd: () => number,
  drift: Drift,
  strength = 1
): Candle[] {
  if (rnd() < 0.07) drift.v = rnd() * 2 - 1;
  const arr = candles.slice();
  const last = { ...arr[arr.length - 1] };
  const gauss = (rnd() + rnd() + rnd() - 1.5) / 1.5;
  const move = last.c * vol * (0.62 * drift.v + 0.85 * gauss) * strength;
  last.c = Math.max(1e-6, last.c + move);
  last.h = Math.max(last.h, last.c);
  last.l = Math.min(last.l, last.c);
  last.n += 1;
  if (last.n >= 7) {
    arr[arr.length - 1] = { ...last, n: 7 };
    arr.push({ o: last.c, h: last.c, l: last.c, c: last.c, n: 0 });
    if (arr.length > 68) arr.shift();
  } else {
    arr[arr.length - 1] = last;
  }
  return arr;
}
/** Volym för historiken ( hur mycket grafen svänger ). */
export function seedVol(entry?: number, sl?: number): number {
  if (!entry) return 0.0011;
  if (!sl) return 0.0011;
  const rel = Math.abs(entry - sl) / entry;
  return Math.min(0.006, Math.max(0.00035, rel / 7));
}
/** Volym per tick — kalibrerad så att 1R nås på några sekunder. */
export function tickVol(entry?: number, sl?: number): number {
  if (!entry || !sl) return 0.0007;
  const rel = Math.abs(entry - sl) / entry;
  return Math.min(0.004, Math.max(0.00012, rel / 14));
}
export interface TickerItem {
  symbol: string;
  price: number;
  change: number;
  decimals: number;
}
export const MARKET_TAPE: TickerItem[] = [
  { symbol: "EUR/USD", price: 1.08524, change: 0.18, decimals: 5 },
  { symbol: "XAU/USD", price: 2035.4, change: -0.42, decimals: 2 },
  { symbol: "BTC/USD", price: 64210, change: 1.94, decimals: 0 },
  { symbol: "NAS100", price: 182.4, change: 0.61, decimals: 1 },
  { symbol: "USD/SEK", price: 10.482, change: -0.09, decimals: 3 },
  { symbol: "GBP/JPY", price: 194.318, change: 0.33, decimals: 3 },
  { symbol: "WTI", price: 78.16, change: -1.12, decimals: 2 },
  { symbol: "OMXS30", price: 2431.8, change: 0.44, decimals: 1 },
  { symbol: "ETH/USD", price: 3184, change: 2.31, decimals: 0 },
  { symbol: "USD/JPY", price: 149.872, change: -0.21, decimals: 3 },
];
