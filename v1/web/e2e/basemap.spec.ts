import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const hasTiles = existsSync(new URL('../public/data/buildings.pmtiles', import.meta.url));
test.skip(!hasTiles, 'run `make tiles` first to build web/public/data/buildings.pmtiles');

type Handle = { map: { queryRenderedFeatures(g?: undefined, o?: { layers: string[] }): unknown[]; areTilesLoaded(): boolean; getStyle(): { layers: { id: string }[] } }; state: { buildings: boolean } };
const handle = (page: Page) => page.evaluate(() => (window as unknown as { edinburghPresence: Handle }).edinburghPresence.state.buildings);

/** A style with a background and one labelled-layer stand-in, served instead of the public one so no network is needed. */
const fakeStyle = (colour: string) => ({
  version: 8,
  sources: { fake: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
  layers: [
    { id: 'fake-background', type: 'background', paint: { 'background-color': colour } },
    { id: 'fake-label', type: 'symbol', source: 'fake', layout: { 'text-field': 'x' } },
  ],
});

async function serveBasemap(page: Page, requested: string[]) {
  await page.route('https://tiles.openfreemap.org/**', (route) => {
    const url = route.request().url();
    requested.push(url);
    if (url.endsWith('/styles/positron')) return route.fulfill({ json: fakeStyle('#f4f4f0') });
    if (url.endsWith('/styles/dark')) return route.fulfill({ json: fakeStyle('#101418') });
    return route.abort();
  });
}

test('uses the light public style and draws the buildings under its labels', async ({ page }) => {
  const requested: string[] = [];
  await serveBasemap(page, requested);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { edinburghPresence?: Handle }).edinburghPresence?.state.buildings === true);
  expect(requested.some((url) => url.endsWith('/styles/positron'))).toBe(true);
  const order = await page.evaluate(() => (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map.getStyle().layers.map((l) => l.id));
  expect(order.indexOf('buildings-3d')).toBeGreaterThan(order.indexOf('fake-background'));
  expect(order.indexOf('buildings-3d')).toBeLessThan(order.indexOf('fake-label')); // labels stay on top
});

test('asks for the dark style in dark mode, and keeps the buildings when the theme changes', async ({ page }) => {
  const requested: string[] = [];
  await serveBasemap(page, requested);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { edinburghPresence?: Handle }).edinburghPresence?.state.buildings === true);
  await page.locator('#theme').click(); // system -> light: same style, no reload
  await page.locator('#theme').click(); // light -> dark
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => requested.some((url) => url.endsWith('/styles/dark'))).toBe(true);
  await page.waitForFunction(() => {
    const { map, state } = (window as unknown as { edinburghPresence: Handle }).edinburghPresence;
    return state.buildings && map.areTilesLoaded() && map.queryRenderedFeatures(undefined, { layers: ['buildings-3d'] }).length > 100;
  });
  await expect(page.locator('#notice')).toBeHidden();
});

test('falls back to a flat background when the basemap cannot be loaded', async ({ page }) => {
  await page.route('https://tiles.openfreemap.org/**', (route) => route.abort());
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { edinburghPresence?: Handle }).edinburghPresence?.state.buildings === true, undefined, { timeout: 20000 });
  const ids = await page.evaluate(() => (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map.getStyle().layers.map((l) => l.id));
  expect(ids).toContain('background');
  expect(await handle(page)).toBe(true);
  await expect(page.locator('#notice')).toBeHidden();
  await expect(page.locator('#status')).toHaveAttribute('data-status', 'warning');
  await expect(page.locator('#status')).toContainText('Basemap unavailable');
});
