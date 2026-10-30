# Frame rate while scrubbing the hour

Milestone M3 acceptance: scrubbing the hour on the pilot area is smooth, with the frame rate measured and recorded.

**Method.** `edinburghPresence.measureScrub(seconds)` (`web/src/perf.ts`) changes the hour on every animation frame for the
given time, which is the worst case: a new paint expression is applied to the buildings and landmark parts each frame. It records
the gap between frames. Headless Chromium, 1440 x 900 viewport, the pilot view at pitch 55, all three building layers loaded
(6,207 mapped buildings, 120 landmark parts, 291 inferred buildings). Measured 2026-10-29, 10 seconds per run.

| Renderer | Frames | Median fps | 5th-percentile fps |
|---|---|---|---|
| Apple M5, ANGLE Metal (GPU) | 600 | 59.9 | 59.9 |
| SwiftShader (software, as used by `make test-e2e`) | 168 | 20 | 12 |

**Reading it.**
- On a GPU the scrub is limited only by the 60 Hz display refresh, so the target of a median of at least 30 fps (plan C28) is met.
- The M5 is a recent high-end laptop chip, not the "mid-range laptop" the plan names. A slower machine is not measured here. Run
  the benchmark on one before relying on it: open the app and enter `await edinburghPresence.measureScrub(10)` in the console.
- Software rendering is below 30 fps. That is a test-runner fallback with no GPU, not a target. The e2e tests do not depend on speed.
