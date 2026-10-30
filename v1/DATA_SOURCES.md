# Data sources

One entry per dataset: URL, licence, access date, checksum. Raw files live in `data/raw/` (gitignored). The machine-readable record is `data/raw/manifest.json`, written by the fetch scripts in `pipeline/`; this file is the human-readable version and must be updated whenever a dataset is added.

Fetched on 2026-10-29 for the **pilot area** only (Old Town and New Town, `config/area.json`; the box is a proposal awaiting confirmation). Every spatial download is clipped to that area. Census files are only published Scotland-wide, so those are small whole-country files, clipped to Edinburgh in later stages.

## Fetched

### OpenStreetMap road network and traffic signals (for the simulated cars)
- Script: `pipeline/fetch_osm_roads.py` (`make cars`), through the Overpass API with geometry and node ids (`out body geom`): drivable highway classes from `config/roads.yaml` (motorway down to residential and living streets, no service roads) and `highway=traffic_signals` nodes, for the pilot box. `pipeline/stage08_roads.py` turns it into `web/public/data/roads.json`.
- File: `data/raw/osm/osm_roads_pilot.json` (985 ways and 156 signal nodes, 0.72 MB, sha256 `3e2477d4b28908a0…`), Overpass snapshot 2026-06-01T08:52:28Z, fetched 2026-10-30 (the endpoint that answered was `overpass.kumi.systems`; `overpass-api.de` gave 502s).
- Licence: ODbL 1.0, (c) OpenStreetMap contributors.
- Used for: where simulated cars can drive, their speed limits (98.7% from `maxspeed` tags), lane counts and the 88 signalised junctions. Cars are a **simulation**: no traffic counts or live traffic feed are used, and placement is by road class and lane length.

### Lothian bus timetables and route shapes (GTFS)
- Scripts: `../lothian/fetch.py` and `../lothian/build.py` (`make buses`). Not under `data/raw/`: the cache is `../lothian/data/raw/` (gitignored).
- URL: https://data.bus-data.dft.gov.uk/timetable/download/gtfs-file/scotland/ (DfT Bus Open Data Service, public, no key). Accessed 2026-10-30, feed version `20261022_034348`.
- File: `scotland.zip` (288.5 MB, sha256 `821a09966dc28233…`). The feed is republished daily, so a later download will differ. Only Lothian Buses, Lothian Country Buses and East Coast Buses bus routes (99) are kept; trams are dropped.
- Used for: route shapes, stop positions, running times and departure gaps (one headway per route). The map shows these as **simulated** buses, never live positions. The keyless BODS vehicle feed has no Lothian vehicles.
- Licence: Open Government Licence v3.0. Credit: DfT Bus Open Data Service.
- No cost, price or fare fields are read.

### Overture Maps buildings and building parts
- Script: `pipeline/fetch_overture.py`. Release pinned to `2026-10-21.0`, read from `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/` with a bounding-box filter.
- Docs: https://docs.overturemaps.org/guides/buildings
- Files: `data/raw/overture/buildings_2026-10-21.0_pilot.parquet` (6,593 rows, 1.6 MB, sha256 `6446c251eca15377…`), `building_parts_2026-10-21.0_pilot.parquet` (934 rows, 0.2 MB, sha256 `25e9b44d5a78e529…`).
- Licence: per-feature, in the `sources` column. In the pilot every record is from OpenStreetMap (6,523) or Microsoft ML Buildings (459), both listed as **ODbL-1.0**. Attribution is required, and ODbL share-alike may apply to published derived databases (see PLAN.md C3).
- Coverage in the pilot: `subtype` 62%, `class` 61%, `num_floors` 27%, `height` 8%.

### OpenStreetMap tags
- Script: `pipeline/fetch_osm.py`, through the Overpass API. Tags and a centre point only (buildings, amenities, shops, offices, tourism); geometry comes from Overture.
- File: `data/raw/osm/osm_tags_pilot.json` (11,392 elements, 2.6 MB, sha256 `d8109790409396ec…`), OSM data timestamp 2026-10-29T01:02:19Z.
- Licence: ODbL 1.0, (c) OpenStreetMap contributors.
- Join: 6,031 of the 6,523 OSM-sourced Overture buildings (92%) match a downloaded element through the Overture `sources.record_id`. Of those, 1,783 have `building:levels` and 106 have an explicit `height` tag.

### OpenStreetMap land-use context
- Script: `pipeline/fetch_osm_context.py`, through the Overpass API, with geometry: land use, leisure, natural, water, railway, highway, place, man_made, amenity and tourism features in the pilot box. Used only to tell which empty ground is streets, parks, rail, water or car park (stage 02b).
- File: `data/raw/osm/osm_context_pilot.json` (21,949 elements, 8.1 MB). Checksum and snapshot time in `data/raw/manifest.json`.
- Licence: ODbL 1.0, (c) OpenStreetMap contributors.

### LiDAR for Scotland, Phase 5 DSM and DTM (0.5 m)
- Script: `pipeline/fetch_lidar.py`. Source bucket `s3://srsp-open-data/lidar/phase-5/` (https://registry.opendata.aws/scottish-lidar, catalogue https://remotesensingdata.gov.scot/data#/list).
- Method: the tiles are tiled GeoTIFFs, so only the pilot window plus a 100 m buffer is read over HTTP range requests (four 5 km tiles: NT27NE, NT27NW, NT27SE, NT27SW). Whole tiles would be about 2.9 GB for the two products; the window is 104 MB.
- Files: `data/raw/lidar/phase5_dsm_pilot.tif` (57.8 MB, sha256 `305bac7a1c6492bb…`), `phase5_dtm_pilot.tif` (46.6 MB, sha256 `8f3ae6db599712ec…`). EPSG:27700, 5200 x 4600 px, nodata -9999, no nodata pixels in the window.
- Licence: Open Government Licence v3.0 (the non-commercial exception applies only to Phase 2 LAZ files, which are not used).
- Sanity check: Castle Rock about 119 m, median surface-minus-terrain 2 m, 99th percentile 29 m.
- **Spike S2 (capture year):** Scottish Government catalogue records say Phase 5 was captured by Fugro for Scottish Power Energy Network in 2020 to 2021 (one record says 2021 to 2022) and delivered in 2021, so treat it as **2020 to 2022 at programme level**. The date over Edinburgh itself could not be confirmed: the bucket has no metadata files and the portal is a script-driven page. Coverage: Phase 5 is the only phase with all four NT27 quadrants; Phase 3 has the SE quadrant only; Phases 1, 2, 4, 6 and the national programme have no NT27 tiles. The data predates the finished St James Quarter, and construction cranes are visible in the DSM.

### Scotland's Census 2022
Script: `pipeline/fetch_census.py`. Licence: Open Government Licence; users should credit "Source: National Records of Scotland licensed under the Open Government Licence". Statistical disclosure control is applied, so cells may not sum to totals.

| File | Source URL | Size | sha256 (start) |
|---|---|---|---|
| `workplace_population_tables_2025-06-17.xlsx` | https://www.scotlandscensus.gov.uk/media/3emcxnis/scotlands-census-2022-workplace-population-tables-17-june-2025.xlsx | 2.5 MB | `90b8e9549be0b573` |
| `output_area_2022_boundaries_clipped_to_coast.zip` | https://www.nrscotland.gov.uk/media/uwdpx4hn/output-area-2022-mhw.zip | 36.7 MB | `aa5a77b6e4ad839a` |
| `output_area_2022_usual_resident_population.csv` | https://www.nrscotland.gov.uk/media/owpknvgk/outputarea2022_usualresidentpopulation.csv | 0.7 MB | `f7af756710c56f33` |
| `oa22_dz22_iz22.zip` | https://www.nrscotland.gov.uk/media/iz3evrqt/oa22_dz22_iz22.zip | 0.2 MB | `3565794561306479` |
| `census_2022_index.zip` | https://www.nrscotland.gov.uk/media/utrbt5ze/census_2022_index.zip | 2.9 MB | `0e4096a321cba231` |

Not fetched on purpose: the 74 MB topic-table bundle and the 96 MB multivariate bundle.

**Findings for spike S1 (daytime definition):**
- The workbook contains both OA-level tables we need: Table 1 (workplace population by output area) and Table 8 (daytime population by output area), so OA-level daytime data exists.
- NRS defines both as alternative population bases built from the census travel-to-work/study question. The cover sheet gives no finer definition, and the daytime tables include a "No code required" industry row, so daytime counts people who are not in work. Daytime therefore appears to include pupils and students who travel to study in the area (relevant to PLAN.md C24). That means `(D - W) / R` is not purely a stay-home share. It also includes people who study in the area.
- City of Edinburgh (`S12000036`): 4,418 OAs, 514,431 usual residents, 284,009 workplace population, 557,191 daytime population. For OAs with residents, `(D - W) / R` has median 0.34 and 3.3% of OAs fall outside [0, 1], which is the expected symptom of that mix. The workplace table has 6 fewer OAs than the daytime table (46,357 against 46,363) and needs a check.
- The definition is still **unconfirmed** in NRS's wording and needs a read of their methodology note before `s_o` is used.

### Whole council area (`AREA=full`), fetched 2026-10-29

The same datasets as the pilot, for the City of Edinburgh council area (S12000036: 263 km², 4,420 census output areas, 491,034 usual residents). The area box is `config/area.json` `full` (BNG 309500, 659200, 332800, 680700); processing is split into the 66 work tiles of 2.5 km in `config/full_tiles.json`. Per-file checksums are in `data/raw/manifest.json`. Licences are as for the pilot entries above.

| Dataset | Files | Size | Detail |
|---|---|---|---|
| Overture buildings | `data/raw/overture/buildings_2026-10-21.0_full.parquet` | 37.4 MB | 196,076 rows, release 2026-10-21.0, sha256 `ecb1692939214994…`. Building parts: 3,442 rows, 0.8 MB, sha256 `864211cfdae0b7d7…`. |
| OpenStreetMap tags | `data/raw/osm/osm_tags_full.json` | 36.3 MB | 241,056 elements from Overpass, snapshot 2026-10-29T13:25:51Z, 23 query boxes of 5 km, sha256 `dc3ec6396532a8c9…`. |
| OpenStreetMap land-use context | `data/raw/osm/osm_context_full.json` | 126.7 MB | 337,607 elements, snapshot 2026-10-29T14:13:31Z, 23 query boxes, sha256 `c5533150d8107acc…`. |
| LiDAR for Scotland Phase 5 DSM and DTM | `data/raw/lidar/phase5_{dsm,dtm}_full_<tile>.tif`, 132 files | 7.89 GB | One windowed read per 2.5 km work tile plus a 100 m buffer, read from the 5 km source tiles (23 of them). Phase 5 exists for every tile. Sea tiles are mostly nodata (up to 78%). Source tile NT37NE does not exist in the bucket, so the buffer beyond it is nodata. |

- Census 2022 council-area totals used to scale the template values (not a model input yet): 491,034 usual residents (sum of the output-area boundary file's `Popcount` for the council area) and a workplace population of 284,009 (Table 1 of the workplace tables, 4,418 output areas).
- Derived: `data/interim/full/` and `data/out/full/` (173,825 mapped buildings, 29,075 inferred buildings, a 48 MB PMTiles file). `docs/infill_full.md` reports what the infill did and did not fill.
- The 2.5 km tile list covers slightly more than the council boundary, so some buildings just outside it are included.

### Published reference heights (validation only)
- File: `docs/height_reference.csv`, ten named buildings inside the pilot with a published height, a definition of what the height measures, the source page and its Wikipedia revision ID.
- Sources: Wikipedia articles and its "List of tallest buildings and structures in Edinburgh" (text under CC BY-SA 4.0; the list cites Emporis). Heights are facts, but the pages are credited here.
- Used only to check the pipeline. They never feed the model. All are tall landmarks, so they say little about ordinary buildings.
- Wikidata was also queried and returned no usable building heights for the area.

### Festival ticket extracts (demand), read 2026-10-30
- Files: the Fringe, EIF and Tattoo 2026 extracts in `../dataset/` (supplied for the hackathon; personal data; git-ignored and never committed). The Tattoo ticket lines also use `customers.csv` for the booker's country.
- Used by `pipeline/stage10_demand.py` for counts only: tickets per venue and show start, and per postcode area. No name, email, customer or order reference is read into the output. Slots under 10 people are dropped. `web/public/data/demand.json` (git-ignored) holds the aggregate.
- The Fringe extract names a venue only by number and carries no postcode, so Fringe audiences sit on assumed hubs and borrow the EIF and Tattoo origin split (`config/demand.yaml`). This is the largest assumption in the demand model.
- EIF venue and Tattoo venue positions come from the Edinburgh festivals feed (`edinburgh_festivals` MCP) where it lists them; The Lyceum, Edinburgh Playhouse and Playfair Library are approximate public-knowledge positions (marked in `config/venues.csv`). The feed refuses a Fringe key and its Fringe demo data is fake, so neither is used.

### City of Edinburgh short-term-let register (visitor accommodation), fetched 2026-10-30
- URL: https://www.edinburgh.gov.uk/downloads/file/32198/short-term-lets (linked from https://www.edinburgh.gov.uk/licences-permits/short-term-lets-public-register), 1.7 MB `.xls`, cached in `data/raw/stl/`; checksum in `data/raw/manifest.json` (sha256 `b822551885536…`, register dated 26 Oct 2026).
- Licence: a council public register; the page states no reuse licence. **Verify before publishing derived data.** Only status, postcode and maximum occupancy are read; the applicant and the street address are never kept, and no price field is present.
- Result: 4,151 issued licences, 16,360 beds, 2,359 of 2,364 postcodes located.
- Postcodes are located with postcodes.io (open, no key; only postcodes are sent), cached in `data/raw/stl/postcodes.json`. A postcode is not an address, so beds are placed on the nearest few buildings (`config/accommodation.yaml`).
- Hotels, guest houses, hostels and halls come from the OpenStreetMap and Overture tags already fetched, with beds estimated from floor area. The citywide hotel bed count in the config is a placeholder.

## Derived outputs (not committed; rebuilt by `make m1`)

`data/interim/footprints.parquet`, `data/interim/heights.parquet`, `data/interim/landmark_parts.parquet`, `data/interim/inferred_buildings.parquet`, `data/out/buildings.parquet`, `data/out/landmark_parts.parquet`, `data/out/inferred_buildings.parquet` and `data/out/buildings.pmtiles` (6,207 buildings, 120 landmark tower parts and 291 inferred buildings). Landmark parts come from the DSM plus the hand-written `config/landmarks.csv`. A full rebuild from the raw files above reproduces the outputs byte for byte. These are derived from ODbL data, so a published copy needs the attribution below and may need to be offered under ODbL (PLAN.md C3).

## Not fetched yet

| Dataset | Status |
|---|---|
| GlobalBuildingAtlas (height fallback, priority 5) | Not needed until gaps remain after LiDAR. Access is through Google Earth Engine; licence to verify. |
| Locomizer hourly footfall (M4) | Gated. Needs an application (PLAN.md C31). |
| LandScan Mosaic (cross-check) | UK availability unconfirmed (spike S6). |
| Pedestrian counters (seasonality) | Needs a data request (spike S7). |
| Scottish Assessors Valuation Roll (use class) | Bulk reuse unclear (spike S4). Never use rateable value or any cost field. |

## Attribution (draft)

OpenStreetMap contributors (ODbL); Overture Maps Foundation and its sources, including Microsoft ML Buildings (ODbL); LiDAR for Scotland (Scottish Government and partners, Open Government Licence v3.0); National Records of Scotland, Scotland's Census 2022 (Open Government Licence). Basemap provider and footfall provider to be added if used.
