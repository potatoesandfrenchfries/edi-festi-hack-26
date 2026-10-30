import { defineConfig } from '@playwright/test';

const PORT = 5273; // not Vite's default, which other local projects commonly occupy
const BASEMAP_PORT = 5274; // a second server that keeps the default basemap, for e2e/basemap.spec.ts

export default defineConfig({
  testDir: 'e2e',
  webServer: [
    {
      // The main suite runs with no basemap so it needs no network.
      command: `VITE_BASEMAP_STYLE_URL=none npm run dev -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}`,
      // Never reuse a server: a different app on this port must fail the run, not be tested.
      reuseExistingServer: false,
    },
    {
      command: `VITE_BASEMAP_STYLE_URL= VITE_BASEMAP_STYLE_URL_DARK= npm run dev -- --port ${BASEMAP_PORT} --strictPort`,
      url: `http://localhost:${BASEMAP_PORT}`,
      reuseExistingServer: false,
    },
  ],
  projects: [
    { name: 'app', testIgnore: /basemap\.spec\.ts/, use: { baseURL: `http://localhost:${PORT}` } },
    { name: 'basemap', testMatch: /basemap\.spec\.ts/, use: { baseURL: `http://localhost:${BASEMAP_PORT}` } },
  ],
  use: {
    // Software GL so headless runs render WebGL without a GPU.
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
  },
});
