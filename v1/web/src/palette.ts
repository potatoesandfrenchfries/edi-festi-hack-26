/**
 * Sequential palette for the occupancy scale: viridis samples, whose lightness rises steadily from low to high, so the order
 * survives red-green and blue-yellow colour-vision deficiencies. palette.test.ts checks this with a simulation.
 */
export const PALETTE = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] as const;

// sRGB hex to linear RGB in [0, 1].
export function linearRgb(hex: string): [number, number, number] {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

/** CIE L*a*b* (D65) of a linear RGB colour. */
export function lab(rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Distance between two colours (CIE76 delta E). About 2 is just noticeable; the scale needs far more between neighbouring classes. */
export function deltaE(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [la, lb] = [lab(a), lab(b)];
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}
