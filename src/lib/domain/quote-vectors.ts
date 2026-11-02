/**
 * The shared quote vectors (SIT-174, reused by SIT-230): edge cases and 400 pseudo-random quotes, as [quantity, unitPriceCents] lines,
 * a discount and a tax rate in basis points. The TypeScript module, an independent SQL formula, and the database function that
 * saves a quote must all agree on every one.
 */
const rng = (() => {
  let s = 20261102;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
})();
const pick = (max: number) => Math.floor(rng() * (max + 1));

export type Vector = { lines: Array<[number, number]>; discount: number; bps: number };
export const EDGES: Vector[] = [
  { lines: [[1, 5]], discount: 0, bps: 1000 },
  { lines: [[1, 25]], discount: 0, bps: 1000 },
  { lines: [[1, 4]], discount: 0, bps: 1250 },
  { lines: [[1, 3]], discount: 0, bps: 1666 },
  { lines: [[1, 123_450]], discount: 0, bps: 825 },
  {
    lines: [
      [100_000, 100_000_000],
      [100_000, 100_000_000],
    ],
    discount: 1,
    bps: 10_000,
  },
  { lines: [[3, 1000]], discount: 3000, bps: 825 },
  {
    lines: [
      [7, 3],
      [1, 0],
      [100_000, 1],
    ],
    discount: 11,
    bps: 1,
  },
  { lines: [], discount: 0, bps: 500 },
];
export const RANDOM: Vector[] = Array.from({ length: 400 }, () => {
  const lines = Array.from(
    { length: 1 + pick(6) },
    () => [1 + pick(99_999), pick(rng() < 0.5 ? 10_000 : 100_000_000)] as [number, number],
  );
  const subtotal = lines.reduce((a, [qty, price]) => a + qty * price, 0);
  return {
    lines,
    discount: rng() < 0.5 ? 0 : pick(Math.min(subtotal, 9_000_000_000_000)),
    bps: pick(10_000),
  };
});
