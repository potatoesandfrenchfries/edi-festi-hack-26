# Edinburgh Presence Map: Design Doc

Working title: `edinburgh-presence`
Status: draft v0.1 (29 Oct 2026)
Audience: Claude Code (implementer) and the project owner (reviewer)

Milestone scope and the open questions for the owner are in `PLAN.md`. Proposed corrections to this document are listed in section 4 of that file and are not applied here until agreed.

---

## 1. Purpose

Build an interactive 3D map of Edinburgh in which every building is an extruded 3D object and is shaded by the **estimated number of people active in it**, by hour of day and day type. The framing is "presence / occupancy", not cost or economic impact.

The project is mostly a **data pipeline**: there is no open source of live per-building people counts, so the numbers are modelled. The web app is a MapLibre map with a client-side hourly expression.

### In scope (v1)
- Edinburgh (City of Edinburgh council area; start with a pilot area, see M1).
- 3D building footprints with heights.
- Modelled people-per-building for weekday / Saturday / Sunday by hour.
- A static web app (no server required) with time slider, day-type toggle and metric toggle.
- Explicit uncertainty and provenance flags on every number.

### Out of scope (v1)
- Any cost, price, rent, rateable-value or economic-impact display.
- Live per-building counts (not available openly; see section 4).
- Live bus/tram/rail layers (see open question Q4).
- The global "world" version. Design choices should not block it later (section 12), but do not build it now.
- Individual-level tracking of any kind. Only aggregated, modelled values.

---

## 2. Key decisions and trade-offs

| # | Decision | Why | Trade-off / counterpoint |
|---|---|---|---|
| D1 | Static site, precomputed tiles, no backend in v1 | No live feed to proxy; simplest to host and test | A backend would be needed later for live layers or API-key hiding |
| D2 | Python 3.12 for data prep, TypeScript/JS (MapLibre GL JS) for the web app | Mature geospatial tooling in Python; MapLibre is the standard open web map renderer | Two languages to maintain |
| D3 | Render with MapLibre `fill-extrusion` first; Three.js custom layer only if needed | Fastest route to 3D buildings; no custom per-object effects are needed yet | `fill-extrusion` limits roof shapes and per-building effects |
| D4 | Ship per-building **base values** (`res_pop`, `work_pop`, `use_class`, `floor_area`) and compute the hourly value **in the client** with a paint expression driven by profile curves | Avoids 72 numeric properties per building (3 day types x 24 h), keeping tiles small | Per-area profile shapes (from footfall data) need extra properties later |
| D5 | Occupancy is modelled by downscaling Census 2022 resident and workplace populations to buildings by floor area and use class | Census workplace/daytime tables are open and published at output-area and data-zone level | Floor-area allocation ignores density differences between buildings of the same class |
| D6 | Hourly shape curves start as parametric placeholders in `config/profiles.yaml`, calibrated in M4 against hourly footfall data if access is granted | Lets M3 ship without gated data | Placeholders are guesses; the UI must say so until calibrated |
| D7 | Height priority: explicit OSM `height` tag, then LiDAR-derived, then Overture `height`, then floors x floor height, then Global Building Atlas, then default | Measured data beats modelled data; tags are human-verified where present | Tag-first can propagate a wrong tag; add a consistency check against LiDAR (M1) |

---

## 3. Users and success criteria

- A viewer can open the page, pick a day type and hour, see 3D Edinburgh with buildings coloured by estimated active people, and click a building to see the estimate, a plausible range, the use class and how the height was derived.
- Success criteria for v1:
  - Pipeline is reproducible from a clean checkout with documented commands.
  - Allocation conserves census totals (see tests, section 9).
  - Heights validated on a sample of landmark buildings (M1).
  - UI clearly states values are modelled estimates, never "live".

---

## 4. Data sources

Status key: **Confirmed** = documented in sources checked while preparing this doc; **Verify** = must be checked in a spike before relying on it.

| Layer | Source | Access / format | Licence / notes | Status |
|---|---|---|---|---|
| Building footprints (+ some heights, floors, class) | Overture Maps buildings theme (conflates OpenStreetMap, Esri Community Maps, Google Open Buildings and others) | GeoParquet on Amazon S3 and Azure Blob; fields include `height`, `num_floors`, `subtype`, `class`. Docs: https://docs.overturemaps.org/guides/buildings | Open; check per-source terms (OSM-derived parts carry ODbL) and record in `DATA_SOURCES.md` | Confirmed (access); Verify (licence summary) |
| Footprints, tags | OpenStreetMap | Geofabrik / Overpass | ODbL; attribution required | Confirmed |
| Surface heights | LiDAR for Scotland Phase 5 DSM (covers Edinburgh per an OSM contributor), Phase 6 DSM/DTM, National Land LiDAR Programme 2025 DSM | Scottish Remote Sensing Portal https://remotesensingdata.gov.scot/data#/list ; Open Data on AWS https://registry.opendata.aws/scottish-lidar | Open Government Licence v3; Phase 2 LAZ is non-commercial | Confirmed. Verify which phase gives full, most recent Edinburgh coverage (S2) |
| Height fallback | GlobalBuildingAtlas (polygons, 3 m height maps, LoD1) | https://gee-community-catalog.org/projects/gba/ | Check licence on the dataset page | Confirmed (content); Verify (licence) |
| Residents | Scotland's Census 2022 usual resident population, output area (OA) | https://www.scotlandscensus.gov.uk/documents/2022-output-area-data ; geography lookups https://www.nrscotland.gov.uk/publications/2022-census-geography-products | Check OGL terms | Confirmed |
| Workers / daytime | Scotland's Census 2022 workplace and daytime population tables (council area and OA; data-zone version also exists). Workplace = people aged 16 to 74 whose main workplace is in the area | https://www.scotlandscensus.gov.uk/documents/scotlands-census-2022-workplace-and-daytime-population-tables-council-area-and-output-area | Check OGL terms; confirm exact definition of "daytime" (S1) | Confirmed (exists); Verify (definition) |
| Use class | OSM `building`/`amenity`/`shop` tags and Overture `subtype`/`class` | as above | Coverage patchy; unknown share of Edinburgh buildings has a class | Verify coverage (S3) |
| Use class (optional) | Scottish Assessors Valuation Roll (property descriptions of non-domestic subjects) | Public lookup via the Assessors portal; bulk extracts are restricted in at least Glasgow's case | **Do not use rateable value or any cost field.** Bulk reuse terms unknown for Edinburgh | Verify (S4) |
| Hourly footfall (calibration) | Locomizer hourly footfall, H3 level 10 (~66 m radius hexes), UK-wide incl. Edinburgh, calendar year 2025, with resident/worker/transient split | Apply via the Healthy & Sustainable Places data service: https://data.hasp.ac.uk/browser/dataset/12488/0 | Access by application; redistribution terms unknown; static 2025 snapshot, not live | Verify (S5) |
| Population grid (cross-check) | LandScan Mosaic, 90 m grid with confidence interval, CC BY 4.0 per the Earth Engine catalog, released in country batches | https://gee-community-catalog.org/projects/landscan_mosaic/ | **Published product is a 90 m grid, not per-building values.** UK availability not confirmed | Verify (S6) |
| Pedestrian counters (calibration/seasonality) | City of Edinburgh Council counters | A review of city counting schemes lists Edinburgh's raw data as unavailable (dashboard only) | May require an FOI/data request | Verify (S7) |
| Template pipeline | Glasgow LiDAR to LoD1/LoD2 workflow (open source): https://github.com/QiaosiLi/construct_building_tree_3d_models_by_lidar | Python/R/C++ | Use as reference, not as a dependency | Confirmed |

---

## 5. Architecture

```
            raw data (gitignored)                interim (parquet)             output
 Overture/OSM footprints ─┐
 LiDAR DSM/DTM ───────────┼─► 01 footprints ─► 02 heights ─► 03 use_class ─┐
 Census OA/DZ tables ─────┤                                                 ├─► 05 allocate ─► 06 tiles ─► web/
 Use-class hints ─────────┘            04 census prep ─────────────────────┘                  (PMTiles + JSON profiles)
 Hourly footfall (optional) ───────────────► 07 calibrate (M4) ─► profiles.yaml
```

- Each stage is a standalone, idempotent Python script reading and writing files in `data/interim/` and `data/out/`. A `Makefile` wires them in order.
- Coordinate handling: process in EPSG:27700 (British National Grid) for areas and heights; publish in EPSG:4326 for tiles.
- Large downloads are cached in `data/raw/` and never committed.

---

## 6. Building data model

One row per building in `data/out/buildings.parquet` (and as tile properties):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable ID (Overture or OSM ID) |
| `geom` | polygon | Footprint |
| `height_m` | float | Final height used for extrusion |
| `height_src` | enum | `osm_tag`, `lidar`, `overture`, `floors`, `gba`, `default` |
| `height_conf` | enum | `high`, `medium`, `low` |
| `floors_est` | float | `height_m / floor_height_m` (config, default stored in `config/model.yaml`) |
| `floor_area_m2` | float | footprint area x `floors_est` |
| `use_class` | enum | `residential`, `retail`, `office`, `hospitality`, `education`, `civic`, `industrial`, `mixed`, `unknown` |
| `use_src` | enum | `osm`, `overture`, `valuation_roll`, `inferred` |
| `oa_id`, `dz_id` | string | Census geography IDs |
| `res_pop` | float | Modelled usual residents (night-time presence) |
| `work_pop` | float | Modelled workplace population |
| `res_lo`, `res_hi`, `work_lo`, `work_hi` | float | Plausible range |

No cost, price or value fields exist anywhere in the schema.

---

## 7. Occupancy model

Notation: `o` = output area, `b` = building, `h` = hour (0 to 23), `d` = day type (weekday, saturday, sunday).

**Step 1: allocate census totals to buildings (static).**
- Residents: `res_pop_b = R_o * A_res_b / sum(A_res)` where `R_o` is the OA's usual resident population and `A_res_b` is the residential floor area of `b`.
- Workers: `work_pop_b = W_o * w_b / sum(w)` where `W_o` is the OA's workplace population, `w_b = A_non_res_b * use_weight[use_class_b]`, and weights live in `config/use_weights.yaml`.
- Mixed-use buildings split floor area using a configurable ratio (default 50/50, flagged as an assumption).
- Fallbacks: if an OA has residents but no residential buildings (or workers but no non-residential buildings), spread over all buildings in the OA and set a `fallback` flag. Never drop population silently.

**Step 2: presence by hour (client-side).**
`P_b(h,d) = res_pop_b * f_res(h,d,class) + work_pop_b * f_work(h,d,class)`

- `f_res` is 1.0 overnight and drops during working hours towards an area-level "stay-home share" `s_o`.
- Assumption to verify in spike S1: `s_o = clip((D_o - W_o) / R_o, 0, 1)` where `D_o` is the census daytime population. If the census definition of daytime does not support this, fall back to a global constant.
- `f_work` is 0 overnight, ramps up around 8 to 9, holds through the working day and ramps down around 17 to 18. Weekend values are scaled down by a configurable factor.
- Curves live in `config/profiles.yaml` as 24 values per (class, day type). **Initial values are placeholders** and must be labelled as such in the UI until M4 calibration.

**Step 3: visitors (M4+).** Census data has no visitors. If hourly footfall access is granted, derive a transient component per hex and distribute it over eligible non-residential buildings (retail, hospitality, civic). Until then the UI must state that visitors and tourists are not modelled.

**Step 4: seasonality (M5+).** Edinburgh has strong seasonal peaks (for example, Festival weeks raised Royal Mile footfall by more than a third in one reported year). Add a month/week multiplier layer from counter data if obtainable; otherwise expose a manual "festival" scalar and label it as such.

**Uncertainty.** `*_lo`/`*_hi` come from allocation sensitivity (vary use weights and floor height within configured bounds) and are shown in the popup. State that ranges describe model sensitivity, not statistical confidence intervals.

---

## 8. Web app

- Single page, MapLibre GL JS, `fill-extrusion` layer from a PMTiles (or equivalent) tileset of `buildings`.
- Controls: day type (weekday / Saturday / Sunday), hour slider with play/pause, metric toggle (people per 1000 m^2 of floor area, default; or total people), legend, light/dark theme.
- Colour encodes the metric; extrusion height is real building height.
- Per-hour value is computed by a MapLibre paint expression built in the client from `res_pop`, `work_pop`, `use_class` and the profile curves for the selected hour and day type. Changing the hour only swaps the expression.
- Click popup: ID, use class and source, height and height source, estimated people with range, flags (`fallback`, low height confidence).
- Permanent banner: "Modelled estimates, not live counts."
- Basemap provider is configurable via env var. Default is a keyless minimal style so the app runs with no secrets (never commit keys, and note that browser-side keys are visible to visitors).
- Accessibility: keyboard-operable slider, colour scale that remains legible for common colour-vision deficiencies, reduced-motion respected for play mode.

---

## 9. Repo layout

```
edinburgh-presence/
  DESIGN.md
  CLAUDE.md              # short rules (section 12) so they load automatically
  DATA_SOURCES.md        # one entry per dataset: URL, licence, date fetched, checksum
  Makefile
  config/
    area.json            # pilot bbox and full council-area settings
    model.yaml           # floor height, mixed-use split, sensitivity bounds
    use_weights.yaml
    profiles.yaml        # hourly curves (placeholders until M4)
  pipeline/              # numbered Python stages, each runnable alone
  web/                   # static app (TypeScript + MapLibre GL JS)
  tests/                 # pytest for pipeline, Playwright or similar for web smoke test
  data/{raw,interim,out} # gitignored
```

Suggested Python libraries (design suggestion, not a hard requirement): DuckDB with spatial extension, GeoPandas, Shapely, rasterio, pyproj, h3. Choose and pin versions in M0.

---

## 10. Milestones and tasks

Each milestone is independently demoable. Claude Code should complete one milestone at a time, run its acceptance checks, and report before starting the next.

### M0: Scaffold and decisions
- Create the repo layout, `Makefile`, config stubs, pinned dependencies, `DATA_SOURCES.md` skeleton and `CLAUDE.md`.
- Acceptance: `make help` lists stages; `make test` runs (even if trivial); a clean clone installs with documented commands.

### M1: Footprints and heights, static 3D
- Task 1.1: Fetch Overture buildings for the pilot bbox (start with a small area covering the Old and New Town, set in `config/area.json`). Record licence info.
- Task 1.2: Fetch LiDAR DSM/DTM tiles covering the pilot area; record phase and capture year (S2).
- Task 1.3: Compute per-footprint height as DSM minus local ground (DTM), using a high percentile of DSM inside the footprint and a ground reference from the DTM around the footprint perimeter. Handle steep terrain explicitly and test it on the Old Town ridge.
- Task 1.4: Merge height sources by the priority in D7; set `height_src` and `height_conf`; flag tag-versus-LiDAR disagreements above a configurable threshold.
- Task 1.5: Render in the web app with uniform colour.
- Acceptance: at least 30 hand-picked landmark and ordinary buildings have documented reference heights and the pipeline is within a stated tolerance on most of them (record tolerance and results in `docs/height_validation.md`); no building has missing or non-positive height; map shows plausible 3D Edinburgh.

### M2: Census join, static day/night occupancy
- Task 2.1: Download census resident and workplace/daytime tables and OA boundaries; join on OA codes; verify totals against published council-area totals.
- Task 2.2: Derive `use_class` (S3) and implement the allocation in section 7, step 1, with fallbacks and flags.
- Task 2.3: Colour buildings by night-time (`res_pop`) and weekday daytime (`work_pop`) density.
- Acceptance: conservation tests pass (sum of building allocations per OA equals the census total within 1e-6 unless a documented fallback applies); fallback share is reported; use-class coverage reported.

### M3: Hourly animation with placeholder profiles
- Task 3.1: Implement `config/profiles.yaml`, the client-side expression, hour slider, day-type toggle, metric toggle and popup.
- Task 3.2: Add the "modelled estimate" banner and a "profiles are uncalibrated" notice.
- Acceptance: scrubbing the hour on the pilot area is smooth (measure and record frame rate on a mid-range laptop); popup values match a pipeline-side recomputation for 20 sampled buildings.

### M4: Calibration and visitors (only if data access is granted)
- Task 4.1: Obtain hourly footfall (S5). If refused or terms forbid publication, keep calibration offline and publish only derived parameters, or skip.
- Task 4.2: Compare aggregated building estimates to per-hex totals; fit per-class or per-area curve adjustments; add a transient visitor component.
- Acceptance: documented error metrics per hour band before and after calibration; the notice about placeholder profiles is removed only if calibration clearly improves agreement.

### M5: Full city, uncertainty and seasonality
- Task 5.1: Run on the full council area; measure tile size and load time; tune tiling.
- Task 5.2: Add ranges to popups and a sensitivity run.
- Task 5.3: Add the seasonality scalar (S7) with clear labelling.
- Acceptance: full-area build completes from a clean checkout; documented tileset size and load time; README explains limitations.

### M6 (optional): Live layers
- Revisit once Q4 is resolved. If a legal, open Edinburgh bus feed exists, poll, interpolate and render vehicles with Three.js instancing.

---

## 11. Validation and testing

- **Conservation tests:** allocated totals equal census totals per OA (unless flagged fallback).
- **Height tests:** unit tests for the DSM minus DTM routine on synthetic slopes; landmark validation table.
- **Reproducibility:** `make all` on a clean checkout produces identical outputs (hash the parquet files).
- **Sanity checks:** no NaN or negative populations; sums over the full area compare to census totals; per-hour totals behave sensibly (night total close to residents, weekday mid-day total consistent with daytime population within the stated assumption).
- **Web smoke test:** page loads, tileset loads, hour change updates paint, popup renders.

---

## 12. Conventions for Claude Code

1. Work milestone by milestone. After each, run its acceptance checks and summarise results (what passed, what did not).
2. Never commit credentials, API keys or large raw data. Use `.env` (gitignored) with a committed `.env.example`.
3. Keep downloads scoped to Edinburgh (the pilot bbox or the council area); prefer windowed or filtered reads over whole-country files. There is no hard size threshold, but report what was fetched. Ask before applying for gated data. Never attempt to bypass access controls.
4. Record every dataset in `DATA_SOURCES.md` (URL, licence, access date, checksum) at the time it is added.
5. Label modelled values as estimates in code, UI and docs. Do not use wording such as "live" or "real-time" for modelled data.
6. Do not add cost, price, rent or rateable-value fields. If a source includes them, drop them in the first pipeline stage.
7. Keep the pipeline idempotent and deterministic; cache raw downloads.
8. Do not invent numbers for profiles or weights silently: every tunable lives in `config/` with a comment on its origin (placeholder, literature, or calibrated).
9. If a "Verify" item in section 4 turns out false, update this document and flag it rather than working around it.
10. Prefer small, tested functions; add tests with the code, not afterwards.

Design hooks for a later global version (do not implement now): keep the pipeline parameterised by area config, keep footprint/height sources behind an interface, and keep the occupancy model separate from tile building so a different population source (for example a building-level population dataset) can replace Step 1.

---

## 13. Risks and open questions

### Risks
- **No open per-building occupancy.** All building-level numbers are modelled; the UI and docs must not imply measurement.
- **Gated or restrictive data.** Hourly footfall and property-level use data may be unavailable or non-redistributable.
- **Old Town terrain.** Steep ridges and stacked tenements can produce wrong heights from naive surface-minus-terrain subtraction.
- **Seasonality.** A fixed profile will misrepresent Festival periods.
- **Tile size.** Full-city building data with per-building properties may be heavy; measure early.

### Spikes (resolve before depending on the item)
- **S1:** Confirm the census definition of "daytime population" and whether `s_o` can be derived as in section 7.
- **S2:** Identify which LiDAR phase and year gives the best Edinburgh coverage and confirm licence for the chosen tiles.
- **S3:** Measure share of Edinburgh buildings with a usable use class from OSM/Overture tags.
- **S4:** Determine whether property-level Valuation Roll use descriptions can be obtained in bulk for Edinburgh and reused. If not, skip.
- **S5:** Apply for or obtain Locomizer hourly footfall; read the licence on publication of derived values.
- **S6:** Check whether LandScan Mosaic covers the UK and whether anything finer than the 90 m grid is available; use only as a cross-check unless building-level values exist.
- **S7:** Find out whether Edinburgh pedestrian counter data can be obtained (for example via a data request) for seasonality.

### Open questions for the project owner
- **Q1:** Pilot first (recommended) or full council area from the start?
- **Q2:** Public hosting planned? That affects licence compliance (ODbL attribution, any footfall data terms).
- **Q3:** Should "active people" include visitors and tourists in v1? Without footfall data they cannot be modelled.
- **Q4:** Live buses: the national bus open data service is reported to take location data mainly from English operators, and a forum post says Lothian's location data does not come from it. Scotland has consulted on its own bus open data regulations, and real-time coverage there has been partial. A live Edinburgh bus layer therefore needs a separate source; defer until confirmed.

---

## 14. Attribution (to be finalised in `DATA_SOURCES.md`)

Expected attributions: OpenStreetMap contributors (ODbL); Overture Maps Foundation and its source datasets; LiDAR for Scotland (Scottish Government and partners, Open Government Licence v3); National Records of Scotland / Scotland's Census 2022; footfall provider if used; basemap provider as required by their terms.
