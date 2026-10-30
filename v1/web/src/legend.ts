// The key to the building colours: purple for festival venues, the public-building colour for high-footfall public places, cream for the rest.
import { BUILDING_COLOUR, PUBLIC_COLOUR, VENUE_COLOUR } from './buildings';

export interface LegendEntry {
  id: 'venue' | 'public' | 'standard';
  label: string;
  colour: string;
}

/** The entries in display order, with the colours the map uses in the given theme. */
export function legendEntries(dark: boolean): LegendEntry[] {
  const theme = dark ? 'dark' : 'light';
  return [
    { id: 'venue', label: 'Festival venues in August', colour: VENUE_COLOUR[theme] },
    { id: 'public', label: 'Public places with high footfall', colour: PUBLIC_COLOUR[theme] },
    { id: 'standard', label: 'Other buildings', colour: BUILDING_COLOUR[theme] },
  ];
}

/** Sets each swatch's colour for the theme. The list itself is in index.html. */
export function renderLegend(root: HTMLElement, dark: boolean): void {
  for (const entry of legendEntries(dark)) {
    root.querySelector<HTMLElement>(`[data-legend="${entry.id}"]`)?.style.setProperty('--swatch', entry.colour);
  }
}
