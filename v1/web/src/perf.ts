/**
 * Scrub benchmark for docs/frame_rate.md: changes the hour on every frame for `seconds` and reports the frame rate.
 * Run it from the browser console: `await edinburghPresence.measureScrub(10)`.
 */
export async function measureScrub(setHour: (hour: number) => void, seconds = 10): Promise<{ frames: number; medianFps: number; p5Fps: number }> {
  const deltas: number[] = [];
  let last = performance.now();
  const end = last + seconds * 1000;
  let hour = 0;
  await new Promise<void>((resolve) => {
    const tick = (now: number) => {
      deltas.push(now - last);
      last = now;
      setHour((hour = (hour + 1) % 24));
      if (now < end) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  const sorted = deltas.slice(1).sort((a, b) => a - b); // first delta includes start-up
  const fps = (ms: number) => Math.round((1000 / ms) * 10) / 10;
  return { frames: sorted.length, medianFps: fps(sorted[Math.floor(sorted.length / 2)]!), p5Fps: fps(sorted[Math.floor(sorted.length * 0.95)]!) };
}
