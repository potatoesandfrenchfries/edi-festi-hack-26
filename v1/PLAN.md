# Edinburgh Presence Map: Delivery Plan

Status: draft v0.1 (29 Oct 2026). Companion to `DESIGN.md`, which stays the source of truth for the model, data sources and schema.
Audience: the project owner (to confirm scope and answer the clarifications) and Claude Code (to implement).

This plan answers two questions: **what exactly is in each milestone**, and **what do we need to know before or during it**. Every open question has an ID (`C1`, `C2`, ...) so answers can be written back in one line. Each has a recommended default; if you do not answer, the default is what I will do, and I will say so in the milestone report.

Blocking means the milestone cannot start, or a task cannot be finished, without an answer.

---

## 1. Overview

| Milestone | Goal | Size | Depends on | Blocking clarifications |
|---|---|---|---|---|
| M0 | Scaffold, tooling, decisions | S | none | C1, C3 (partly), C9 to C12 |
| M1 | Footprints and heights, static 3D | L | M0 | C6, C14, C16, C18 |
| M2 | Census join, static day/night occupancy | L | M1 | C20, C21, C24 |
| M3 | Hourly animation with placeholder profiles | M | M2 | C25, C26 |
| M4 | Calibration and visitors (conditional) | M | M3 and data access | C31 (owner action) |
| M5 | Full city, ranges, seasonality | M | M3 | C34, C35 |
| M6 | Live layers (optional, parked) | n/a | Q4 | C37 |

```
M0 ─► M1 ─► M2 ─► M3 ─┬─► M5
                      └─► M4 (only if footfall access is granted)
                  M6 parked until a legal Edinburgh live feed is confirmed
```

M4 and M5 are independent once M3 exists. M5 does not wait for M4; if M4 lands later it just improves the profiles.

### Work that has a long lead time (start early)

These need owner action and may take weeks, so they should start during M0 even though the work that uses them is later.

| Item | Why early | Who acts |
|---|---|---|
| Apply for hourly footfall access (S5) | Gated, approval time unknown; M4 is only possible if granted | Owner applies. I can draft the application text and a data-use summary. |
| Request Edinburgh pedestrian counter data (S7) | May need a formal data request or FOI | Owner sends. I can draft it. |
| Decide hosting (C3) | Determines licence obligations and the basemap choice | Owner |

---

## 2. Milestones

### M0: Scaffold and decisions

**Goal.** A clean checkout that installs, lists its stages and runs a trivial test, with every later decision recorded.

**In scope**
- Repo layout from `DESIGN.md` section 9, created at the repo root (see C1).
- `Makefile` with `help`, `install`, `test` and one target per pipeline stage (stubs that fail clearly with "not implemented").
- Python 3.12 environment through `uv`, with pinned dependencies. The machine default is Python 3.14, so the version is pinned explicitly.
- Web project: TypeScript, Vite, MapLibre GL JS, PMTiles protocol, Vitest, Playwright (see C9).
- Config stubs: `area.json`, `model.yaml`, `use_weights.yaml`, `profiles.yaml`. Every value carries a comment naming its origin (placeholder, literature, or calibrated).
- `DATA_SOURCES.md` skeleton with one empty entry per source in design section 4.
- `CLAUDE.md` with the section 12 rules, `.gitignore`, `.env.example`.
- Pre-commit style checks: formatter and linter for Python and TypeScript.
- `DESIGN.md` (the design doc) added to the repo.

**Out of scope.** Any data download, any real pipeline logic, any map rendering beyond a blank map smoke test.

**Acceptance (from the design doc, plus one addition)**
- `make help` lists every stage.
- `make test` runs and passes (a trivial test per language is enough).
- A clean clone installs with the documented commands only.
- Added: the web app starts and shows a blank basemap without any secret set.

**Clarifications**

| ID | Question | Why it matters | Recommended default | Blocking? |
|---|---|---|---|---|
| C1 | Scaffold at the repo root (`edi-festi-26`) or in a nested `edinburgh-presence/` folder? | The design doc shows a nested folder name, the working directory is a separate repo. | Repo root. The repo name does not have to match the working title. | Yes |
| C9 | Web stack: vanilla TypeScript with Vite, no UI framework? | Keeps the bundle small and the map code direct. A framework adds weight for one page. | Vanilla TS, Vite, Vitest, Playwright. | No |
| C10 | Python data stack: DuckDB (spatial) as the main engine, GeoPandas and rasterio where needed? | Affects how Parquet and joins are written, and reproducibility. | DuckDB for joins and Parquet, rasterio for LiDAR, Shapely for geometry. | No |
| C11 | Tile builder: tippecanoe (installed with Homebrew) or another tool? | Needed in M1 to make PMTiles. Installing it is a system change. | tippecanoe. Falls back to a pure-Python writer if you do not want Homebrew installs. | Needed by M1 |
| C12 | Licence for this repo's own code, and for derived data you publish? | Goes in the README and `DATA_SOURCES.md`. ODbL share-alike may constrain the data licence. | MIT for code. Data licence decided in C3. | No |
| C4 | Git workflow: may I commit at the end of each milestone, and on a branch per milestone? Should I push? | I only commit when asked. The repo has no commits yet. | Branch per milestone, commit at the end of each, no pushing until you say. | No |
| C5 | Tool installs: may I install `uv`-managed Python 3.12, npm packages and Playwright browsers without asking each time? Homebrew packages only with a prompt? | Avoids repeated permission interruptions. | Yes for uv, pip, npm and Playwright. Ask before Homebrew. | No |

---

### M1: Footprints and heights, static 3D

**Goal.** A uniform-colour 3D Edinburgh pilot area with defensible building heights and a documented accuracy.

**In scope**
- Task 1.1: fetch Overture buildings for the pilot bbox from a pinned release. Record the release and licence terms.
- Task 1.2: fetch LiDAR DSM and DTM tiles for the pilot. Record phase and capture year (spike S2).
- Task 1.3: per-footprint height as high-percentile DSM minus a ground reference from the DTM around the perimeter. Explicit handling and a test for steep terrain on the Old Town ridge.
- Task 1.4: merge height sources by the D7 priority. Set `height_src` and `height_conf`. Flag tag-versus-LiDAR disagreements above a configurable threshold.
- Task 1.5: web app renders the buildings as uniform-colour `fill-extrusion` from a PMTiles file. Basemap provider configurable, keyless by default.
- Interim and output Parquet files, and a PMTiles builder (EPSG:27700 processing, EPSG:4326 publishing).
- `docs/height_validation.md`: the validation table and tolerance.
- Stage 01 (footprints) and stage 02 (heights) of the pipeline, idempotent and cached.

**Out of scope.** Use class, census, colours by occupancy, full-city run, Global Building Atlas fallback beyond a stub (it is the fifth priority and only needed if gaps remain).

**Acceptance (design doc)**
- At least 30 landmark and ordinary buildings with documented reference heights.
- The pipeline is within a stated tolerance on most of them. Proposed numbers, to confirm in C16: within 3 m or 15% (whichever is larger) on at least 80% of buildings.
- No building has a missing or non-positive height.
- The map shows plausible 3D Edinburgh.
- Added: re-running the stage produces identical output (the reproducibility check begins here).

**Spikes in this milestone.** S2 (LiDAR phase, coverage, licence).

**Main risk.** Old Town terrain. Tenements built on steep ground make a "DSM minus nearest ground" height wrong on the downhill side. The ground reference is taken from the perimeter's low percentile, and the validation set must include ridge and Royal Mile buildings.

**Clarifications**

| ID | Question | Why it matters | Recommended default | Blocking? |
|---|---|---|---|---|
| C14 | Exact pilot bounding box. | Sets download sizes and what "plausible" means. | Old Town and New Town, roughly the area between the Castle, Holyrood, Princes Street and the Georgian grid. I will propose exact coordinates and show them on a map for you to confirm before downloading. | Yes |
| C15 | Which source gives the base footprints: Overture alone, or Overture plus OSM tags joined in? | Decides duplicates and the use of OSM `height` tags (priority 1 in D7). | Overture as the footprint source, joined to OSM tags through Overture's source references. Verified in the spike. | No |
| C16 | Who sources the reference heights for the 30 validation buildings, and what is the tolerance? | An unbiased reference matters. Using OSM tags as the reference would be circular, because they also feed the model. | I compile the list from public, cited sources (for example published building heights and architect or heritage records) and mark what could not be sourced. You review it. Tolerance as above. | Yes (for acceptance) |
| C6 | Standing approval for downloads: the design doc requires a question before anything over 1 GB. May I proceed on the pilot if the total is under a stated figure (for example 3 GB)? | LiDAR tiles can be large. A single approval avoids a stop mid-milestone. | I report the size before downloading and wait for your yes if it is over 1 GB. | Yes if over 1 GB |
| C18 | Which basemap, given it must be keyless? Options: (a) no basemap, just a flat background and the buildings; (b) a keyless public vector style from a free provider; (c) a self-hosted PMTiles basemap built from OSM extracts. | Needs a licence and attribution check, and whether it can be loaded in tests. | (a) for M1 and M3, then (b) or (c) once hosting (C3) is known. | No |
| C19 | Threshold for flagging a tag-versus-LiDAR height disagreement. | Placeholder in `config/model.yaml`. | Flag when they differ by more than 3 m and more than 25%, labelled as a placeholder. | No |

---

### M2: Census join, static day/night occupancy

**Goal.** A defensible static allocation of residents and workers to buildings, shown as night and weekday-daytime density.

**In scope**
- Task 2.1: download census resident and workplace/daytime tables and OA boundaries. Join on OA codes. Verify totals against published council-area totals.
- Task 2.2: derive `use_class` (spike S3) and implement the allocation in design section 7 step 1, with the fallback rules and flags.
- Task 2.3: colour buildings by night-time (`res_pop`) and weekday daytime (`work_pop`) density. Two fixed views, not yet animated.
- Stage 03 (use class), stage 04 (census prep), stage 05 (allocation) of the pipeline.
- Reports: fallback share and use-class coverage.
- Spikes S1 (daytime definition and `s_o`), S3 (use-class coverage), S4 (Valuation Roll; skip if bulk use is not allowed).

**Out of scope.** Hourly curves, visitors, ranges, seasonality, cost or rateable-value fields (dropped in the first stage if a source carries them).

**Acceptance (design doc)**
- Conservation tests pass: per-OA sums equal the census totals within 1e-6 unless a documented fallback applies.
- Fallback share is reported.
- Use-class coverage is reported.
- Added: no NaN or negative populations, and the full-pilot sum matches the census sum for the pilot's OAs.

**Main risks.** Large unknown-class share in the city centre. Floor-area allocation treating a student hall and a mansion block alike. Workplace data only counting people aged 16 to 74 whose main workplace is in the area, so pupils, students, patients, and anyone outside that definition are absent from `work_pop`.

**Clarifications**

| ID | Question | Why it matters | Recommended default | Blocking? |
|---|---|---|---|---|
| C20 | If S1 shows the census "daytime population" cannot give the stay-home share `s_o`, what constant should replace it? | The residential daytime curve depends on it. | I report the S1 result first, then propose a single value with its origin, flagged as a placeholder in `profiles.yaml`. | After S1 |
| C21 | If the share of buildings with a usable use class is low (S3), do you want to pursue the Valuation Roll (S4)? Is there a coverage figure below which you would? | Valuation Roll bulk reuse is uncertain, and it is the only likely route to better classes. | Do not pursue unless coverage is under 60% in the pilot. Never use rateable value. | After S3 |
| C22 | Communal establishments (student halls, care homes, hotels, hospitals): treat as residential, or as a separate class? | The census counts people living in them as usual residents, so they must be somewhere. Tourist stays are not counted. | Residential when tagged as such, flagged, and listed in the report. No new class in v1. | No |
| C23 | Confirm the mixed-use split of 50/50. | It is an assumption in `model.yaml`. | 50/50, labelled as an assumption. | No |
| C24 | Pupils, students and similar: in v1, are they modelled? The census workplace table does not include them, and Edinburgh has large universities and many schools. | Without them, daytime presence in education buildings is understated. This is a visible gap on the map. | Not in v1. The UI and README say so. Revisit if a place-of-study census table is available at OA level. | Yes (scope) |

---

### M3: Hourly animation with placeholder profiles

**Goal.** The interactive product: pick a day type and hour, see buildings recolour smoothly, click a building for its estimate.

**In scope**
- Task 3.1: `config/profiles.yaml` loaded by the client, a paint expression built from `res_pop`, `work_pop`, `use_class` and the selected hour and day type, an hour slider with play and pause, day-type and metric toggles, legend, popup.
- Task 3.2: permanent "Modelled estimates, not live counts." banner and an "uncalibrated profiles" notice.
- UI shell: control panel with keyboard-operable slider, light and dark theme, minimise control, reduced-motion handling, a responsive layout for phones, saved settings in browser storage with safe fallbacks.
- Pipeline-side recomputation of the same formula, used as a test oracle.
- Playwright smoke test: page loads, tileset loads, hour change updates paint, popup renders.
- Popup: ID, use class and source, height and height source, estimate, flags (`fallback`, low height confidence).

**Out of scope.** Uncertainty ranges (M5), visitors (M4), seasonality (M5), live data.

**Acceptance (design doc)**
- Scrubbing the hour on the pilot area is smooth, with the frame rate measured and recorded on a mid-range laptop.
- Popup values match the pipeline-side recomputation for 20 sampled buildings.
- Added: the colour scale remains legible under common colour-vision deficiencies (checked with a simulation), and play mode respects reduced motion.

**Clarifications**

| ID | Question | Why it matters | Recommended default | Blocking? |
|---|---|---|---|---|
| C25 | Colour scale: one fixed scale across all hours, or one that rescales per hour? Linear, log or quantile? | A fixed scale lets the viewer see the city fill and empty over the day. Per-hour rescaling hides it. Density is heavy-tailed, so linear scales leave most buildings the same colour. | Fixed across hours, square-root or log-like steps with a colour-vision-safe sequential palette, and break points shown in the legend. | Yes |
| C26 | Who sets the placeholder curves in `profiles.yaml`? | The numbers drive everything on screen. The doc forbids silent invented numbers. | I draft simple, documented shapes (night, ramp, hold, ramp down) per class, each with an origin comment saying "placeholder", and you review the file. | Yes |
| C27 | Weekend scaling factors for work presence (Saturday and Sunday). | Also a placeholder. | Office work presence: Saturday 0.2, Sunday 0.1. Retail and hospitality: Saturday 1.0, Sunday 0.8. All labelled as placeholders. You can overrule. | No |
| C28 | Which device counts as the "mid-range laptop" and what is the frame-rate target? | Acceptance needs a number. | Your laptop, with a median of at least 30 frames per second at pilot scale. | No |
| C29 | The design says the popup shows a plausible range, but ranges are built in M5. Pull the range work forward, or keep it in M5 and show estimates only until then? | Consistency of success criteria. | Keep in M5. The M3 popup shows the estimate only. | No |
| C30 | Default metric: the doc says people per 1000 m² of floor area. Floor area depends on estimated floors, so heights errors propagate. Confirm. | The default view should be the one you trust most. | Keep the doc's default, show the height confidence flag in the popup. | No |

---

### M4: Calibration and visitors (conditional)

**Goal.** Replace placeholder shapes with fitted ones and add a visitor component, only if hourly footfall data is legally and practically available.

**In scope**
- Task 4.1: obtain hourly footfall (S5). If access is refused or the terms forbid publication, either keep calibration offline and publish only fitted parameters, or skip the milestone.
- Task 4.2: compare aggregated building estimates to per-hex totals, fit per-class or per-area curve adjustments, add a transient visitor component for eligible non-residential buildings.
- Stage 07 (calibration) of the pipeline, writing a new `profiles.yaml` whose values are marked "calibrated" with the data source and date.
- Error report per hour band before and after.

**Out of scope.** Publishing raw footfall, or anything redistributed beyond what the licence allows. Real-time footfall.

**Acceptance (design doc).** Documented error metrics per hour band before and after calibration. The "placeholder profiles" notice is removed only if calibration clearly improves agreement.

**Dependency.** Data access (owner action). If it does not arrive, the milestone is recorded as skipped with the reason, and the app keeps the notice.

**Clarifications**

| ID | Question | Why it matters | Recommended default | Blocking? |
|---|---|---|---|---|
| C31 | Will you apply for the footfall data (S5), and by when should I give up waiting? | I cannot apply for gated data on your behalf. | You apply; I draft the request. If there is no access by the start of M5, M4 is marked skipped. | Yes (owner action) |
| C32 | Q3 from the design doc: should "active people" include visitors and tourists in v1? | Without footfall data they cannot be modelled, and the headline numbers exclude them. | No visitors in v1 unless M4 succeeds. The UI says visitors are not modelled. | Yes (scope) |
| C33 | If the licence forbids publishing derived values per building, is it acceptable to publish only fitted curve parameters? | The per-building visitor component would otherwise be redistributing the data. | Yes. | After S5 |

---

### M5: Full city, uncertainty and seasonality

**Goal.** Run the whole City of Edinburgh area, show how uncertain each number is, and handle seasonal peaks honestly.

**In scope**
- Task 5.1: full council-area run. Measure PMTiles size and load time, tune tiling (zoom range, simplification, attribute precision).
- Task 5.2: `res_lo`, `res_hi`, `work_lo`, `work_hi` from a sensitivity run over use weights and floor height. Ranges in the popup, with the wording that ranges describe model sensitivity, not statistical confidence.
- Task 5.3: a seasonality scalar. Counter data if it arrives (S7), otherwise a manual "festival" scalar clearly labelled as such.
- README with limitations, a build-from-clean-checkout check, and a recorded tileset size and load time.
- Hosting configuration for the chosen target (C3), including whether the host supports HTTP range requests, which PMTiles needs.

**Out of scope.** Live layers, any server.

**Acceptance (design doc).** The full-area build completes from a clean checkout. Tileset size and load time documented. README explains limitations.

**Main risk.** Tile size and per-building property volume across the council area, including rural areas where buildings are sparse and large OAs have few classes.

**Clarifications**

| ID | Question | Why it matters | Recommended default | Blocking? |
|---|---|---|---|---|
| C34 | A tile-size or load-time budget for the full city? | Gives the tuning a target. | Measure first, then agree. Initial aim: a first meaningful render in a few seconds on a typical broadband connection. | No |
| C35 | Seasonality: do you want the manual festival scalar if counter data does not arrive, and what range? | Edinburgh's August population is far from the average year, so a fixed profile misleads. | Yes, a single multiplier on non-residential presence with a visible label, range 1.0 to 1.5, clearly a placeholder. | No |
| C2 | Is the Edinburgh festival period the headline use case? The repo name suggests it. | If yes, visitors (C32) and seasonality (C35) move from "nice to have" to central, and M4 and S7 move earlier. | Treat the festival as a stretch scenario, not the headline, until you say otherwise. | Yes (priorities) |
| C38 | Should inferred buildings (`docs/infill.md`) receive census residents and workers in M2? | They are not mapped. Giving them population changes the density of real neighbours, but leaving them out under-counts floor area where the maps are incomplete. | LiDAR-detected structures yes, flagged; standard frontage plots no. Decide at M2. | Before M2 |
| C36 | Sensitivity bounds for the uncertainty run (use weights, floor height). | They define what the range means. | Set in `model.yaml` with comments, for example plus or minus 25% on weights and plus or minus 0.5 m on floor height, as placeholders. | No |

---

### M6 (optional): Live layers

**Goal.** Only if Q4 resolves with a legal, open Edinburgh live feed.

**In scope if started.** Poll, interpolate and render vehicle positions. This needs a small server for keys and caching, which breaks D1, so it needs its own design note first.

**Out of scope for now.** Everything. Nothing in M0 to M5 should depend on it.

| ID | Question | Recommended default | Blocking? |
|---|---|---|---|
| C37 | Do you want M6 kept on the roadmap, or removed for v1? | Keep it parked. It consumes no effort until a feed is confirmed. | No |

---

## 3. Cross-cutting clarifications

| ID | Question | Recommended default |
|---|---|---|
| C3 | (Q2) Will this be hosted publicly, and where? This sets: ODbL attribution and share-alike obligations for the published data, any footfall licence terms, the basemap choice, and whether the host supports range requests for PMTiles. | Undecided. Develop locally. Choose a host before M5. I will write `DATA_SOURCES.md` so it is compliant either way. |
| C7 | Who is the audience for the finished map: a class or assessor, the public, city planners? | Assume a technical demo audience. This changes how much explanatory text the UI needs. |
| C8 | Is there a deadline or demo date? | None assumed. If there is one, M0 to M3 is the minimum useful product, and M4 and M5 can be cut. |

---

## 4. Corrections I propose to the design doc

I will make these in `DESIGN.md` once you agree, and record them there.

| # | Issue | Proposed fix |
|---|---|---|
| A1 | The popup shows a `fallback` flag and section 7 requires one, but the building schema (section 6) has no field for it. | Add `alloc_fallback_res` and `alloc_fallback_work` (booleans) to the schema. |
| A2 | Section 3 says the popup shows a plausible range, but ranges are produced in M5 (Task 5.2). | Success criteria apply to v1 as a whole. Make M3 show estimates only. See C29. |
| A3 | Section 12 rule 2 puts the basemap provider in `.env`. In a static app, any `.env` value used by the browser is baked into the bundle and public. | State that the basemap setting is public configuration. Never put a secret there. |
| A4 | Reproducibility check hashes Parquet files, but Parquet bytes can differ between runs through row order or metadata even when the data is identical. | Sort deterministically before writing and hash a canonical content digest (and the PMTiles file) rather than rely on raw file bytes. |
| A5 | Day types are weekday, Saturday and Sunday. Public holidays and festival days fall outside them. | Note it in the limitations. Festival handled by the M5 scalar. |
| A6 | `f_work` and the `use_weights` description do not say how education buildings are handled, but pupils and students are not in the census workplace table. | See C24. State the limitation in the model section. |
| A7 | Spike S5 and S7 have long lead times but sit late in the plan. | Start the requests in M0, see section 1. |
| A8 | D7 is tag-first, but in the pilot OSM `height` tags that disagree with LiDAR were wrong in all four landmark cases where a published height exists (Nelson Monument tagged 3 m against 32 m published; The Hub, Tron Kirk and Buccleuch Free Church each tagged 15 m against 52 to 74 m). | The pipeline keeps D7's order, but when the consistency check fails it uses LiDAR and flags the building (`on_disagreement: prefer_lidar` in `config/model.yaml`). `keep_tag` restores the literal reading. Needs owner confirmation (question C39). |
| A10 | The owner allowed hand-curated fixes so iconic buildings look like themselves. A prism cannot show a spire, so landmarks need parts as well as a height. | `height_src` gains `manual`. A short list in `config/landmarks.csv` gives each landmark a body height and up to four nested tower parts taken from the LiDAR, topped at the published height. Parts live in their own table and tile layer (`landmark_parts`), never in `buildings`, so the occupancy model never counts them as buildings. The automated height is kept in `auto_height_m`, and validation uses that, because the override copies the published heights. |
| A11 | The owner asked for empty regions to be filled with standard buildings on the basis of OpenStreetMap. OSM explains about 80% of the pilot's ground (buildings, roads, parks and gardens, rail, water, car parks, plazas), so most visually empty space is legitimately open. | Stage 02b adds **inferred** buildings only for the ground OSM leaves unexplained: real structures seen in the LiDAR (drawn from it), and standard frontage plots on bare flat ground beside mapped buildings. Parks, gardens, rail, water, trees, steep ground, courtyards and lone patches stay empty. Inferred buildings have their own table and tile layer, a lighter tone, and are not in `buildings`. Whether they take census population in M2 is a new decision (C38). `infill.enabled` and `infill.fill_open_ground` switch them off. See `docs/infill.md`. |
| A9 | Roof level is not defined in the design doc. | Roof level is the 99th percentile of the DSM in the footprint, because the maximum picks up construction cranes (one block reads 111 m). Spires stay 10 to 20 m low; building parts (Overture `building_part`) are the likely fix. See `docs/height_validation.md`. |

---

## 5. Status after M3 (29 Oct 2026)

The owner paused M2, M4 and M5 and asked to jump to M3. The project is for now a **visualisation template for Edinburgh**: the data to be represented has not been decided.

- **M3 is built** on template values. Stage 06 gives each building a `use_class` (from OSM and Overture tags) and `res_pop` and `work_pop` proportional to floor area, using placeholder densities in `config/model.yaml`. These are stand-ins, with the column names the census allocation will produce, so M2 can replace them later without touching the web app. Inferred buildings and the landmark parts follow C38: inferred buildings have no estimate, and a tower part is drawn in its parent's colour.
- **Festival feature** (C2, C35): implemented as a manual multiplier on the workers' share, range 1.00 to 1.50 in `config/model.yaml`. No visitors or footfall.
- **Not met or not measured:** M1's height acceptance (C16) is still open. The frame rate was measured on an Apple M5, which is not a mid-range laptop (`docs/frame_rate.md`). The density view shows differences between use classes only, because floor-area allocation gives every building of a class the same density.
- **Whole city built (29 Oct 2026, at the owner's request; this is M5 task 5.1 pulled forward, with no ranges or seasonality).** `make city AREA=full` fetches Phase 5 LiDAR for the 66 work tiles of the council area (7.89 GB), Overture buildings and OSM, and builds 173,825 mapped buildings and 29,075 inferred ones into a 48 MB PMTiles file. Heights: 97.5% from LiDAR, 1.3% fall back to the 6 m default (mostly sheds under 2 m, see below). The template worker total is scaled to the Census 2022 workplace population (284,009) and the resident total matches the census to 0.7%; only totals are matched, not where people are. Not done for the city: height validation (pilot only), tile-size and load-time tuning (C34), hosting (C3). Inferred buildings are 14% of the city's buildings (9,857 from LiDAR, 19,218 plots), more than in the pilot, and have not been checked on the ground.
- M3 acceptance: popups match the pipeline recomputation for 20 sampled buildings (`web/src/presence.test.ts`, from `data/out/oracle.json`); the colour scale is checked under protan, deutan and tritan simulation (`web/src/palette.test.ts`); play respects reduced motion (`web/e2e/smoke.spec.ts`).

## 6. Open questions (status after M1)

M0 and M1 are built and on `main`. Everything below has a default that is already in use, so nothing is blocked, but these are the answers that would change the work. Reply with the ID and an answer; the decision log below is updated from that.

### Needed before or during M2

| ID | Question | Default in use | Why it matters |
|---|---|---|---|
| **C16** | Can you supply reference heights for ordinary (non-landmark) buildings, or accept the current evidence? Open web sources gave only 10 independent landmark heights (target 30), and 5 of 10 are within tolerance (target 80%). See `docs/height_validation.md`. | Keep the 10 references and the OSM cross-check, which is not independent. | The M1 acceptance check is not met until this is resolved. Ordinary buildings are most of the map. |
| **C39** | When an OSM `height` tag disagrees with LiDAR, which wins? D7 says tag first; the pipeline now prefers LiDAR and flags the building, because in the pilot the tags were wrong in all 4 landmark checks that have a published height (A8). | `on_disagreement: prefer_lidar` in `config/model.yaml`. | Departs from a literal reading of D7. `keep_tag` restores it. |
| **C38** | Should inferred buildings (`docs/infill.md`) receive census residents and workers in M2? | LiDAR-detected structures yes, flagged; standard frontage plots no. | Changes the density of mapped neighbours versus under-counting floor area where the maps are incomplete. |
| **C24** | Are pupils and students modelled? The census workplace table excludes them, and the daytime table appears to include them. | Not in v1; the UI says so. | Schools and universities will look emptier than they are. |
| **C2** | Is the Edinburgh festival period the headline use case? | No: a stretch scenario. | If yes, visitors (C32) and seasonality (C35) move to the centre and M4 and S7 move earlier. |

### Still open from earlier, later milestones

| ID | Question | Default in use |
|---|---|---|
| C3 | Public hosting, and where? Sets ODbL obligations (the built tiles derive from ODbL data), the basemap choice and range-request support for PMTiles. | Develop locally; decide before M5. |
| C31 | Will you apply for the hourly footfall data (S5), and by when should I give up waiting? | You apply; M4 is skipped if access has not arrived by the start of M5. |
| C32 | Do "active people" include visitors in v1? | No, unless M4 succeeds. |
| C20, C21 | What replaces the stay-home share if the census daytime definition does not support it, and is the Valuation Roll worth pursuing if use-class coverage is low? | Decided after spikes S1 and S3 report. |
| C25, C26 | Colour scale and the placeholder hourly curves. | Fixed scale across hours; I draft the curves for your review in M3. |

### Decisions taken without an explicit answer

Recorded so they can be reversed: pilot box (C14), tippecanoe install (C11), roof level at the 99th percentile, curated landmarks (A10), inferred buildings and their lighter tone (A11). Each is a config value or a switch, not a one-way change.

### Decision log

Fill in or ask me to fill in as you answer.

| ID | Answer | Date |
|---|---|---|
| C1 | Default applied: scaffold at the repo root (not explicitly confirmed) | 2026-10-29 |
| C2 | Festival is likely the headline use case. For now, implement the festival feature only (the manual festival scalar, C35); visitors and footfall stay deferred. | 2026-10-29 |
| C3 | | |
| C4 | | |
| C5 | | |
| C6 | No hard size threshold. Keep downloads Edinburgh-only and report sizes afterwards. | 2026-10-29 |
| C9 | | |
| C10 | | |
| C11 | tippecanoe installed with Homebrew on 2026-10-29 (proceeded on the go-ahead for M1; not explicitly confirmed) | 2026-10-29 |
| C12 | | |
| C14 | Pilot box used as proposed in `config/area.json` (proceeded on the go-ahead; not explicitly confirmed) | 2026-10-29 |
| C16 | Open. Ten independent references compiled from open sources (`docs/height_reference.csv`); 30 is not reachable that way. Owner input needed. | 2026-10-29 |
| C24 | Not needed. Pupils and students are not modelled. The project is a visualisation template for Edinburgh; the data to be represented has not been decided yet. | 2026-10-29 |
| C25 | Default applied: fixed break points shared by all hours, square-root-like steps, a viridis sequential palette, breaks shown in the legend (`config/model.yaml` `colour_scale`). Not explicitly confirmed. | 2026-10-29 |
| C31 | | |
| C32 | | |
| C38 | Not a concern for now. Inferred buildings are left out of the M2 allocation (simplest reading; reversible later). | 2026-10-29 |
| C39 | Open. Default in use: prefer LiDAR when an OSM tag disagrees (`on_disagreement: prefer_lidar`). | 2026-10-29 |
| C26 | Default applied: parametric placeholder curves drafted in `config/profiles.yaml`, each labelled placeholder. Not yet reviewed by the owner. | 2026-10-29 |
| C27 | Default applied: office weekend work 0.2 (Sat) and 0.1 (Sun); retail and hospitality 1.0 and 0.8. Placeholders. | 2026-10-29 |
| C28 | Default applied: measured on this development machine (an Apple M5, 60 fps, vsync-capped). Not a mid-range machine, and not confirmed to be the owner's laptop; see `docs/frame_rate.md`. | 2026-10-29 |
| C29 | Default applied: the M3 popup shows the estimate only, no range. | 2026-10-29 |
| C30 | Default applied: people per 1000 m² of floor area, with the height-confidence flag in the popup. | 2026-10-29 |
| C35 | Festival multiplier range 1.00 to 1.50 as proposed, implemented now (owner: "just implement the feature"). | 2026-10-29 |
| M2, M4, M5 | Paused by the owner. M3 built first on template values. | 2026-10-29 |
