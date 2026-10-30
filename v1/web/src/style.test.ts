import { describe, expect, it } from 'vitest';
import { basemapStyleUrl, DEFAULT_BASEMAP } from './config';
import { blankStyle } from './style';

describe('blankStyle', () => {
  it('has no sources, so it needs no network or key', () => {
    expect(blankStyle(false).sources).toEqual({});
  });
  it('has a background layer that differs between themes', () => {
    const colour = (dark: boolean) => {
      const layer = blankStyle(dark).layers[0];
      if (layer?.type !== 'background') throw new Error('expected a background layer');
      return layer.paint?.['background-color'];
    };
    expect(colour(true)).not.toBe(colour(false));
  });
});

describe('basemapStyleUrl', () => {
  it('defaults to a keyless light or dark public style', () => {
    expect(basemapStyleUrl(false, {})).toBe(DEFAULT_BASEMAP.light);
    expect(basemapStyleUrl(true, {})).toBe(DEFAULT_BASEMAP.dark);
    expect(basemapStyleUrl(false, { VITE_BASEMAP_STYLE_URL: '  ' })).toBe(DEFAULT_BASEMAP.light);
  });
  it('lets one URL replace both themes, and a dark URL replace only the dark one', () => {
    const env = { VITE_BASEMAP_STYLE_URL: ' https://example.test/style.json ' };
    expect(basemapStyleUrl(false, env)).toBe('https://example.test/style.json');
    expect(basemapStyleUrl(true, env)).toBe('https://example.test/style.json');
    expect(basemapStyleUrl(true, { ...env, VITE_BASEMAP_STYLE_URL_DARK: 'https://example.test/dark.json' })).toBe('https://example.test/dark.json');
    expect(basemapStyleUrl(false, { ...env, VITE_BASEMAP_STYLE_URL_DARK: 'https://example.test/dark.json' })).toBe('https://example.test/style.json');
  });
  it('turns the basemap off with "none"', () => {
    expect(basemapStyleUrl(false, { VITE_BASEMAP_STYLE_URL: 'none' })).toBeNull();
    expect(basemapStyleUrl(true, { VITE_BASEMAP_STYLE_URL: 'NONE' })).toBeNull();
  });
  it('never defaults to a URL with a key in it', () => {
    for (const url of Object.values(DEFAULT_BASEMAP)) expect(url).not.toMatch(/key=|token=|apikey/i);
  });
});
