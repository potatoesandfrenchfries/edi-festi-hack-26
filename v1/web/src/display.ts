/** Display presets: trade picture detail for speed on slower machines. Thresholds are placeholders, set from one laptop's measurements. */
export type Preset = 'detailed' | 'balanced' | 'light';
export const PRESET_NAMES: readonly Preset[] = ['detailed', 'balanced', 'light'];

export interface PresetSpec {
  label: string;
  description: string;
  /** Highest device pixel ratio to render at (null: the screen's own). Fewer pixels draw faster. */
  pixelRatioCap: number | null;
  /** Buildings appear from this zoom. A higher zoom means fewer buildings on screen at once. */
  minZoom: number;
  /** Whether the inferred buildings may be drawn at all. */
  inferred: boolean;
}

export const PRESETS: Record<Preset, PresetSpec> = {
  detailed: { label: 'Detailed', description: 'Full resolution, buildings from zoom 13.', pixelRatioCap: null, minZoom: 13, inferred: true },
  balanced: { label: 'Balanced', description: 'Slightly lower resolution on sharp screens.', pixelRatioCap: 1.5, minZoom: 13, inferred: true },
  light: { label: 'Light', description: 'Standard resolution, buildings from zoom 14, no inferred buildings.', pixelRatioCap: 1, minZoom: 14, inferred: false },
};

export function pixelRatioFor(preset: Preset, devicePixelRatio: number): number {
  const cap = PRESETS[preset].pixelRatioCap;
  return cap === null ? devicePixelRatio : Math.min(devicePixelRatio, cap);
}

export const SPEED_TEST_SECONDS = 3;
const SMOOTH_FPS = 45; // placeholder: a median at or above this feels smooth
const USABLE_FPS = 25; // placeholder: below this, scrubbing visibly stutters

export interface SpeedAdvice {
  level: 'smooth' | 'usable' | 'slow';
  text: string;
  suggest: Preset | null;
}

/** What to tell someone whose hour-scrub ran at `medianFps`. The test changes the hour every frame, which is the worst case. */
export function speedAdvice(medianFps: number, current: Preset): SpeedAdvice {
  const fps = Math.round(medianFps);
  if (medianFps >= SMOOTH_FPS) return { level: 'smooth', text: `${fps} fps while scrubbing. Smooth, no change needed.`, suggest: null };
  const next: Preset = medianFps >= USABLE_FPS ? 'balanced' : 'light';
  if (PRESET_NAMES.indexOf(current) >= PRESET_NAMES.indexOf(next)) {
    return { level: medianFps >= USABLE_FPS ? 'usable' : 'slow', text: `${fps} fps while scrubbing, even on ${PRESETS[current].label}. Zoom in closer or hide inferred buildings.`, suggest: null };
  }
  return { level: medianFps >= USABLE_FPS ? 'usable' : 'slow', text: `${fps} fps while scrubbing. Try ${PRESETS[next].label}.`, suggest: next };
}
