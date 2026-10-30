import { describe, expect, it } from 'vitest';
import { BUILDING_COLOUR, PUBLIC_COLOUR, VENUE_COLOUR } from './buildings';
import { legendEntries } from './legend';

describe('legendEntries', () => {
  it('uses the colours the map draws, per theme', () => {
    const colours = (dark: boolean) => Object.fromEntries(legendEntries(dark).map((entry) => [entry.id, entry.colour]));
    expect(colours(false)).toEqual({ venue: VENUE_COLOUR.light, public: PUBLIC_COLOUR.light, standard: BUILDING_COLOUR.light });
    expect(colours(true)).toEqual({ venue: VENUE_COLOUR.dark, public: PUBLIC_COLOUR.dark, standard: BUILDING_COLOUR.dark });
  });
});
