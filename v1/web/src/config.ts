// Public configuration. Everything here ships to the browser, so it must never hold a secret.

/** Centre of the pilot area (Old Town and New Town), as [longitude, latitude]. */
export const PILOT_CENTRE: [number, number] = [-3.18983, 55.95283];

export const PILOT_VIEW = { zoom: 15.5, pitch: 55, bearing: -20 } as const;

/** Keyless public styles from OpenFreeMap (OpenStreetMap data). Credit is added by the style's own attribution. */
export const DEFAULT_BASEMAP = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
} as const;

/**
 * Basemap style for the theme, or null for a flat background with no network. `VITE_BASEMAP_STYLE_URL` replaces both themes
 * (`VITE_BASEMAP_STYLE_URL_DARK` replaces the dark one), and the value `none` turns the basemap off.
 */
export function basemapStyleUrl(dark = false, env: Record<string, string | undefined> = import.meta.env): string | null {
  const read = (name: string) => env[name]?.trim() || undefined;
  const shared = read('VITE_BASEMAP_STYLE_URL');
  if (shared?.toLowerCase() === 'none') return null;
  const chosen = (dark ? read('VITE_BASEMAP_STYLE_URL_DARK') : undefined) ?? shared;
  return chosen ?? (dark ? DEFAULT_BASEMAP.dark : DEFAULT_BASEMAP.light);
}
