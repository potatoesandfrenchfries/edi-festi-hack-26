# Edinburgh presence map

An interactive 3D map of Edinburgh in which each building is shaded by the **modelled** number of people active in it, by hour of day and day type.

**These are modelled estimates, not live counts.** No open source of per-building occupancy exists. The design is to allocate Scotland's Census 2022 resident and workplace populations to buildings by floor area and use class, but that step (M2) is paused: what the map shows today are **template values**, placeholder populations proportional to floor area, with a use class read from OpenStreetMap and Overture tags (`pipeline/template_values.py`). They are not census figures. The hourly profiles are placeholders until calibrated. Visitors and tourists are not modelled, and neither are pupils and students.

Status: milestones M0 (scaffold), M1 (footprints, LiDAR heights, static 3D pilot map) and M3 (hourly animation: day type, hour slider with play, metric toggle, legend, popup, manual festival multiplier) are built. M2 (census allocation), M4 (calibration) and M5 (full city) are paused, so the map is a visualisation template whose data is still to be chosen. M1's height acceptance check is not met (see `docs/height_validation.md`). See `PLAN.md` for the scope of each milestone and `DESIGN.md` for the model. M3 frame-rate results are in `docs/frame_rate.md`.

## Setup

Requires [uv](https://docs.astral.sh/uv/), Node 22 or newer, and `make`.

```sh
make install            # Python 3.12 environment and web dependencies
make test               # Python tests, web typecheck and unit tests
make install-browsers   # once, for the browser smoke test
make test-e2e
make web-dev            # start the web app; Vite prints the URL
```

Fetch the pilot-area data (about 150 MB, cached in `data/raw/`, gitignored):

```sh
make fetch
```

Build the pilot map (needs `brew install tippecanoe`), then view it with `make web-dev`:

```sh
make m1                 # footprints, heights, tiles and the height validation report
```

### The whole city

The pilot covers the Old Town and New Town (5 km²). The whole City of Edinburgh council area (263 km², 66 work tiles of 2.5 km) is built with the same stages, one tile at a time so whole-city rasters never have to fit in memory:

```sh
make city AREA=full     # fetch (several GB, cached and resumable per tile), footprints, heights, infill, tiles
```

`AREA=full` writes to `data/interim/full/` and `data/out/full/`, so the pilot outputs are never overwritten. Both builds copy their tiles to `web/public/data/buildings.pmtiles`, so whichever you built last is what `make web-dev` shows (run `make tiles` for the pilot again to switch back). Buildings are drawn from zoom 13. LiDAR comes from Phase 5 for every tile. The tile list is `config/full_tiles.json` (regenerate with `uv run python -m pipeline.area_tiles`). A tile also reads a 100 m LiDAR buffer, and an empty-ground patch for the infill belongs to the tile that holds its centre, so nothing is cut or drawn twice at tile edges. The 2.5 km tile list covers slightly more than the council boundary, so some buildings just outside it are included.

`make tiles` also writes `web/public/data/profiles.json` (hourly curves, festival range and colour break points for the web app) and `data/out/oracle.json` (20 sampled buildings with the values the pipeline expects, which the web unit tests check the client against).

`make help` lists everything else, including one target per pipeline stage. Stages 03 to 05 and 07 are stubs that exit with "not implemented yet"; the tile stage supplies the template values instead.

## Using the map

Pick a day type and an hour (or press Play), and choose whether colour shows people per 1000 m² of floor area or people in the building. The scale has fixed break points, shared by every hour, so the city visibly fills and empties. Click a building for its estimate, use class and height source. The **festival scenario** slider multiplies the workers' share by 1.00 to 1.50. It is a manual scenario, not a measurement. With reduced motion set in the operating system, Play steps more slowly. The **Display** tab switches inferred buildings, landmark towers and building heights on and off, and offers three performance presets (Detailed, Balanced, Light: lower resolution, a later zoom, no inferred buildings). **Test speed** scrubs the hour for three seconds and recommends a preset from the frame rate. A status line at the bottom of the panel shows how many buildings loaded, or says when the basemap fell back to a flat background. Settings are remembered in the browser when storage is available.

The hourly curves are parametric shapes in `config/profiles.yaml`; colour break points, the festival range and the template densities are in `config/model.yaml`. All are placeholders.

## Configuration

The basemap defaults to a flat background with no key. To use another keyless style, copy `.env.example` to `.env` and set `VITE_BASEMAP_STYLE_URL`. That value is compiled into the page and is public, so never put a secret in it.

Twelve iconic buildings (spires, towers, monuments) are listed in `config/landmarks.csv` and drawn with stepped towers so the skyline reads correctly; everything else uses the automatic LiDAR height.

Where OpenStreetMap and the footprint data leave ground empty, `make infill` adds **inferred** buildings (real structures seen in the LiDAR, and standard frontage buildings beside mapped ones). They are drawn in a lighter tone and never mixed into the mapped buildings. Parks, gardens, rail, water, trees and slopes stay empty. See `docs/infill.md`.

Model parameters live in `config/`. Each value is tagged with its origin (placeholder, literature, calibrated or assumption).

## Data and attribution

See `DATA_SOURCES.md` for every dataset, its licence, access date and checksum. Contains OpenStreetMap data (ODbL), Overture Maps data, LiDAR for Scotland and Scotland's Census 2022 data (Open Government Licence v3.0).
