import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';

type Map = {
  loaded(): boolean;
  isStyleLoaded(): boolean;
  areTilesLoaded(): boolean;
  getStyle(): { sources: object };
  queryRenderedFeatures(geometry?: undefined, options?: { layers: string[] }): { properties: { height_m: number }; geometry: { type: string; coordinates: number[][][] } }[];
  getPaintProperty(layer: string, name: string): unknown;
  getLayoutProperty(layer: string, name: string): unknown;
  jumpTo(options: object): void;
  project(lngLat: [number, number]): { x: number; y: number };
};
type Handle = { map: Map; state: { buildings: boolean }; measureScrub(seconds: number): Promise<{ medianFps: number; p5Fps: number; frames: number }> };
const handle = '(window as unknown as { edinburghPresence: Handle }).edinburghPresence';
const hasTiles = existsSync(new URL('../public/data/buildings.pmtiles', import.meta.url));

function collectErrors(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  return errors;
}

test('loads with no secrets and shows the modelled-estimate banner', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('#banner')).toHaveText('Modelled estimates, not live counts.');
  await page.waitForFunction(() => (window as unknown as { edinburghPresence?: Handle }).edinburghPresence?.map.loaded());
  await expect(page.locator('canvas.maplibregl-canvas')).toBeVisible();
  const sources = await page.evaluate(() => Object.keys((window as unknown as { edinburghPresence: Handle }).edinburghPresence.map.getStyle().sources));
  expect(sources.every((name) => name === 'buildings')).toBe(true); // no basemap source, so no key is needed
  expect(errors).toEqual([]);
});

test('shows a notice instead of failing when the tiles have not been built', async ({ page }) => {
  test.skip(hasTiles, 'tiles exist, so the notice path cannot be exercised');
  await page.goto('/');
  await expect(page.locator('#notice')).toBeVisible();
});

test.describe('with built tiles', () => {
  test.skip(!hasTiles, 'run `make tiles` first to build web/public/data/buildings.pmtiles');

  test('renders extruded buildings with real heights', async ({ page }) => {
    const errors = collectErrors(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { edinburghPresence?: Handle }).edinburghPresence?.state.buildings === true);
    await page.waitForFunction(() => {
      const { map } = (window as unknown as { edinburghPresence: Handle }).edinburghPresence;
      return map.areTilesLoaded() && map.queryRenderedFeatures(undefined, { layers: ['buildings-3d'] }).length > 100;
    });
    const heights = await page.evaluate(() =>
      (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map
        .queryRenderedFeatures(undefined, { layers: ['buildings-3d'] })
        .map((f) => f.properties.height_m),
    );
    expect(Math.max(...heights)).toBeGreaterThan(30);
    expect(Math.min(...heights)).toBeGreaterThan(0);
    // Landmark spires are separate parts, so the skyline reaches well above the building bodies.
    const partHeights = await page.evaluate(() =>
      (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map
        .queryRenderedFeatures(undefined, { layers: ['landmark-parts-3d'] })
        .map((f) => f.properties.height_m),
    );
    expect(partHeights.length).toBeGreaterThan(10);
    expect(Math.max(...partHeights)).toBeGreaterThan(55);
    // Inferred buildings fill gaps and are drawn as their own layer.
    const inferred = await page.evaluate(() =>
      (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map
        .queryRenderedFeatures(undefined, { layers: ['inferred-3d'] })
        .map((f) => f.properties.height_m),
    );
    expect(inferred.length).toBeGreaterThan(5);
    expect(Math.min(...inferred)).toBeGreaterThan(0);

    // Pixel check: a good share of the canvas is not background grey.
    const png = await page.locator('canvas.maplibregl-canvas').screenshot();
    const { share } = await page.evaluate(async (b64) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(image.width, image.height).getContext('2d')!;
      c.drawImage(image, 0, 0);
      const { data } = c.getImageData(0, 0, image.width, image.height);
      let other = 0;
      for (let i = 0; i < data.length; i += 4) {
        const near = Math.abs(data[i]! - 0xe8) + Math.abs(data[i + 1]! - 0xe6) + Math.abs(data[i + 2]! - 0xe1) < 24;
        if (!near) other++;
      }
      return { share: other / (data.length / 4) };
    }, png.toString('base64'));
    expect(share).toBeGreaterThan(0.15);
    expect(errors).toEqual([]);
  });
});


test.describe('controls and popup', () => {
  test.skip(!hasTiles, 'run `make tiles` first to build web/public/data/buildings.pmtiles');

  async function ready(page: import('@playwright/test').Page) {
    await page.goto('/');
    await page.waitForFunction(() => (window as unknown as { edinburghPresence?: Handle }).edinburghPresence?.state.buildings === true);
    await expect(page.locator('#panel')).toBeVisible();
  }
  const colourJson = (page: import('@playwright/test').Page) =>
    page.evaluate(() => JSON.stringify((window as unknown as { edinburghPresence: Handle }).edinburghPresence.map.getPaintProperty('buildings-3d', 'fill-extrusion-color')));

  test('shows the uncalibrated notice and the legend', async ({ page }) => {
    await ready(page);
    await expect(page.locator('#profile-notice')).toContainText('Uncalibrated placeholder profiles');
    await expect(page.locator('#profile-notice')).toContainText('not census figures');
    await expect(page.locator('#legend li')).toHaveCount(6); // neutral + 5 classes
    await expect(page.locator('#legend-inferred')).toContainText('not modelled');
  });

  test('changing the hour, day type and metric changes the paint expression', async ({ page }) => {
    await ready(page);
    await page.locator('#hour').fill('3');
    const night = await colourJson(page);
    await page.locator('#hour').fill('12');
    await expect.poll(() => colourJson(page)).not.toBe(night);
    const weekday = await colourJson(page);
    await page.getByLabel('Sunday').check();
    await expect.poll(() => colourJson(page)).not.toBe(weekday);
    const sunday = await colourJson(page);
    await page.getByLabel('Per building').check();
    await expect.poll(() => colourJson(page)).not.toBe(sunday);
    await expect(page.locator('#legend-title')).toContainText('People in building');
  });

  test('the hour slider works from the keyboard', async ({ page }) => {
    await ready(page);
    await page.locator('#hour').fill('9');
    await page.locator('#hour').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#hour-label')).toHaveText('10:00');
    await page.keyboard.press('End');
    await expect(page.locator('#hour-label')).toHaveText('23:00');
  });

  test('the festival multiplier changes the paint and the headline, and is labelled as manual', async ({ page }) => {
    await ready(page);
    await page.locator('#hour').fill('12');
    const before = await colourJson(page);
    const people = await page.locator('#stat-people').textContent();
    await page.getByRole('tab', { name: 'Scenario' }).click();
    await expect(page.locator('#view-scenario')).toBeVisible();
    await expect(page.locator('#festival-reset')).toBeHidden();
    await page.locator('#festival').fill('1.5');
    await expect(page.locator('#festival-label')).toHaveText('×1.50');
    await expect.poll(() => colourJson(page)).not.toBe(before);
    await expect(page.locator('#view-scenario .hint')).toContainText('not a measurement');
    await page.getByRole('tab', { name: 'Explore' }).click();
    await expect(page.locator('#stat-people')).not.toHaveText(people!);
    await page.getByRole('tab', { name: 'Scenario' }).click();
    await page.locator('#festival-reset').click();
    await expect(page.locator('#festival-label')).toHaveText('×1.00');
  });

  test('tabs switch panels, move with the arrow keys and expose their state', async ({ page }) => {
    await ready(page);
    await expect(page.getByRole('tab', { name: 'Explore' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Explore' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Scenario' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#view-explore')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.locator('#view-about')).toBeVisible();
    await expect(page.locator('#view-about')).toContainText('Template values');
    // The pill slides to the selected tab (it animates for about half a second).
    await expect
      .poll(async () => Math.abs((await page.locator('.tab-indicator').boundingBox())!.x - (await page.getByRole('tab', { name: 'About' }).boundingBox())!.x))
      .toBeLessThan(2);
  });

  test('the headline numbers follow the hour', async ({ page }) => {
    await ready(page);
    await page.locator('#hour').fill('3');
    const night = await page.locator('#stat-people').textContent();
    await page.locator('#hour').fill('12');
    await expect(page.locator('#stat-people')).not.toHaveText(night!);
    await expect(page.locator('#stat-residents')).toHaveText(/^[\d,]+$/);
  });

  test('the inferred-buildings switch hides and shows that layer', async ({ page }) => {
    await ready(page);
    await page.getByRole('tab', { name: 'Display' }).click();
    const visibility = () =>
      page.evaluate(() => (window as unknown as { edinburghPresence: { map: { getLayoutProperty(l: string, p: string): string | undefined } } }).edinburghPresence.map.getLayoutProperty('inferred-3d', 'visibility'));
    await expect(page.locator('#show-inferred')).toBeChecked();
    await page.locator('#show-inferred').uncheck();
    await expect.poll(visibility).toBe('none');
    await page.locator('#show-inferred').check();
    await expect.poll(visibility).toBe('visible');
  });

  test('clicking a building opens a popup with an estimate', async ({ page }) => {
    await ready(page);
    await page.waitForFunction(() => {
      const { map } = (window as unknown as { edinburghPresence: Handle }).edinburghPresence;
      return map.areTilesLoaded() && map.queryRenderedFeatures(undefined, { layers: ['buildings-3d'] }).length > 100;
    });
    // Look straight down so a roof sits over its own footprint, then click the middle of some buildings until one answers.
    await page.evaluate(() => (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map.jumpTo({ pitch: 0, bearing: 0 }));
    await page.waitForFunction(() => (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map.areTilesLoaded());
    const points = await page.evaluate(() => {
      const { map } = (window as unknown as { edinburghPresence: Handle }).edinburghPresence;
      return map
        .queryRenderedFeatures(undefined, { layers: ['buildings-3d'] })
        .filter((f) => f.geometry.type === 'Polygon')
        .slice(0, 40)
        .map((f) => {
          const ring = f.geometry.coordinates[0]!;
          const lng = ring.reduce((sum, p) => sum + p[0]!, 0) / ring.length;
          const lat = ring.reduce((sum, p) => sum + p[1]!, 0) / ring.length;
          return map.project([lng, lat]);
        });
    });
    const box = (await page.locator('canvas.maplibregl-canvas').boundingBox())!;
    let opened = false;
    for (const point of points) {
      if (point.x < 5 || point.y < 5 || point.x > box.width - 5 || point.y > box.height - 5) continue;
      await page.mouse.click(box.x + point.x, box.y + point.y);
      if (await page.locator('.popup').count()) {
        opened = true;
        break;
      }
    }
    expect(opened).toBe(true);
    await expect(page.locator('.popup')).toContainText('people');
    await expect(page.locator('.popup')).toContainText('Template value from floor area, not a census figure');
    await expect(page.locator('.popup')).toContainText('Height');
  });

  test('play advances the hour, more slowly under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await ready(page);
    await page.locator('#hour').fill('5');
    await page.locator('#play').click();
    await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(1200);
    await expect(page.locator('#hour-label')).toHaveText('05:00'); // the normal 0.7 s cadence would already have moved on
    await expect(page.locator('#hour-label')).toHaveText('06:00', { timeout: 3000 });
    await page.locator('#play').click();
    await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'false');
  });

  test('play steps through the hours at the normal cadence', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await ready(page);
    await page.locator('#hour').fill('5');
    await page.locator('#play').click();
    await expect(page.locator('#hour-label')).toHaveText('06:00', { timeout: 1500 });
  });

  test('settings are remembered and the page works with storage blocked', async ({ page, browser }) => {
    await ready(page);
    await page.locator('#hour').fill('17');
    await page.getByLabel('Saturday').check();
    await page.reload();
    await expect(page.locator('#hour-label')).toHaveText('17:00');
    await expect(page.getByLabel('Saturday')).toBeChecked();

    const blocked = await browser.newContext();
    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
    });
    const second = await blocked.newPage();
    const errors = collectErrors(second);
    await ready(second);
    await expect(second.locator('#hour-label')).toHaveText('09:00');
    expect(errors).toEqual([]);
    await blocked.close();
  });

  test('theme button cycles through light and dark and minimise hides the controls', async ({ page }) => {
    await ready(page);
    await page.locator('#theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('#theme').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('#minimise').click();
    await expect(page.locator('#hour')).toBeHidden();
    await expect(page.locator('#banner')).toBeVisible();
    await expect(page.locator('#profile-notice')).toBeVisible();
  });

  test('the loading overlay goes away and the status line reports the buildings', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading')).toHaveClass(/is-done/, { timeout: 30000 });
    await expect(page.locator('#status')).toHaveAttribute('data-status', 'ready');
    await expect(page.locator('#status')).toContainText(/[\d,]+ buildings · modelled estimates/);
  });

  test('display switches hide towers, flatten heights and are remembered', async ({ page }) => {
    await ready(page);
    await page.getByRole('tab', { name: 'Display' }).click();
    const prop = (layer: string, kind: 'layout' | 'paint', name: string) =>
      page.evaluate(
        ([l, k, n]) => {
          const { map } = (window as unknown as { edinburghPresence: Handle }).edinburghPresence;
          return k === 'layout' ? map.getLayoutProperty(l!, n!) : map.getPaintProperty(l!, n!);
        },
        [layer, kind, name] as const,
      );
    await page.locator('#show-towers').uncheck();
    await expect.poll(() => prop('landmark-parts-3d', 'layout', 'visibility')).toBe('none');
    await page.locator('#show-heights').uncheck();
    await expect.poll(() => prop('buildings-3d', 'paint', 'fill-extrusion-height')).toBe(0);
    await page.locator('#show-heights').check();
    await expect.poll(() => prop('buildings-3d', 'paint', 'fill-extrusion-height')).toEqual(['get', 'height_m']);
    await page.locator('#show-towers').uncheck();
    await page.reload();
    await page.waitForFunction(() => (window as unknown as { edinburghPresence?: Handle }).edinburghPresence?.state.buildings === true);
    await page.getByRole('tab', { name: 'Display' }).click();
    await expect(page.locator('#show-towers')).not.toBeChecked();
  });

  test('the Light preset hides inferred buildings, draws from a later zoom and moves the zoom hint with it', async ({ page }) => {
    await ready(page);
    await page.getByRole('tab', { name: 'Display' }).click();
    await expect(page.locator('#preset-light')).toContainText('zoom 14');
    const visibility = () =>
      page.evaluate(() => (window as unknown as { edinburghPresence: { map: { getLayoutProperty(l: string, p: string): string | undefined } } }).edinburghPresence.map.getLayoutProperty('inferred-3d', 'visibility'));
    await expect.poll(visibility).toBe('visible');
    await page.getByLabel(/^Light/).check();
    await expect.poll(visibility).toBe('none');
    await expect(page.locator('#show-inferred')).toBeChecked(); // the user's own choice is kept, Light just overrides it
    const zoomTo = (zoom: number) => page.evaluate((z) => (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map.jumpTo({ zoom: z }), zoom);
    await zoomTo(13.5);
    await expect(page.locator('#zoom-hint')).toBeVisible(); // 13.5 is enough for Detailed but not for Light
    await page.getByLabel(/^Detailed/).check();
    await expect(page.locator('#zoom-hint')).toBeHidden();
  });

  test('the speed test reports a frame rate and restores the hour', async ({ page }) => {
    await ready(page);
    await page.locator('#hour').fill('7');
    await page.getByRole('tab', { name: 'Display' }).click();
    await page.locator('#speed-test').click();
    await expect(page.locator('#speed-test')).toBeDisabled();
    await expect(page.locator('#speed-result')).toContainText(/\d+ fps while scrubbing/, { timeout: 15000 });
    await expect(page.locator('#speed-test')).toBeEnabled();
    await page.getByRole('tab', { name: 'Explore' }).click();
    await expect(page.locator('#hour-label')).toHaveText('07:00');
  });

  test('the About sections open and close', async ({ page }) => {
    await ready(page);
    await page.getByRole('tab', { name: 'About' }).click();
    await expect(page.getByText('Template values.')).toBeVisible();
    await expect(page.getByText('Visitors, tourists, pupils and students.')).toBeHidden();
    await page.getByText('What is not modelled').click();
    await expect(page.getByText('Visitors, tourists, pupils and students.')).toBeVisible();
  });

  test('says to zoom in when zoomed out too far to draw buildings', async ({ page }) => {
    await ready(page);
    const zoomTo = (zoom: number) => page.evaluate((z) => (window as unknown as { edinburghPresence: Handle }).edinburghPresence.map.jumpTo({ zoom: z }), zoom);
    await expect(page.locator('#zoom-hint')).toBeHidden();
    await zoomTo(10.5);
    await expect(page.locator('#zoom-hint')).toBeVisible();
    await zoomTo(15);
    await expect(page.locator('#zoom-hint')).toBeHidden();
  });

  test('is usable at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await ready(page);
    const panel = (await page.locator('#panel').boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
  });
});
