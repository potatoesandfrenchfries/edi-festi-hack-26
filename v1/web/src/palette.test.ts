import { describe, expect, it } from 'vitest';
import { BUILDING_COLOUR } from './buildings';
import { deltaE, lab, linearRgb, PALETTE } from './palette';

type Matrix = readonly [readonly number[], readonly number[], readonly number[]];
// Machado, Oliveira and Fernandes (2009), full severity, applied to linear RGB.
const SIMULATIONS: Record<string, Matrix> = {
  none: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const simulate = (hex: string, m: Matrix): [number, number, number] => {
  const rgb = linearRgb(hex);
  const out = m.map((row) => Math.min(Math.max(row[0]! * rgb[0] + row[1]! * rgb[1] + row[2]! * rgb[2], 0), 1));
  return [out[0]!, out[1]!, out[2]!];
};

describe.each(Object.entries(SIMULATIONS))('colour scale under %s', (_name, matrix) => {
  const colours = PALETTE.map((hex) => simulate(hex, matrix));
  it('keeps neighbouring classes clearly apart', () => {
    for (let i = 1; i < colours.length; i++) expect(deltaE(colours[i - 1]!, colours[i]!)).toBeGreaterThan(15);
  });
  it('keeps the order: lightness rises from low to high', () => {
    for (let i = 1; i < colours.length; i++) expect(lab(colours[i]!)[0]).toBeGreaterThan(lab(colours[i - 1]!)[0] + 5);
  });
  it('keeps the neutral "below the first break" colour apart from the first class', () => {
    for (const neutral of [BUILDING_COLOUR.light, BUILDING_COLOUR.dark]) expect(deltaE(simulate(neutral, matrix), colours[0]!)).toBeGreaterThan(15);
  });
});
