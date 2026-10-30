.DEFAULT_GOAL := help
.PHONY: city help install install-py install-web install-browsers buses cars economics demand accommodation transport fetch footprints heights infill use-class census allocate tiles calibrate all m1 validate-heights \
        test test-py test-web test-e2e lint web-dev web-build clean

# AREA=full runs the whole council area (outputs go to data/*/full/); the default is the pilot.
AREA ?= pilot
export PRESENCE_AREA := $(AREA)

PY := uv run python -m
WEB := npm --prefix web

help: ## List the available targets
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  %-16s %s\n", $$1, $$2}'

install: install-py install-web ## Install Python and web dependencies
install-py: ## Create the Python 3.12 environment from uv.lock
	uv sync
install-web: ## Install web dependencies from package-lock.json
	$(WEB) ci
install-browsers: ## Install the Chromium used by the browser smoke test
	cd web && npx playwright install chromium

buses: ## Lothian bus simulation data for the map (public timetables, ~290 MB download cached in ../lothian/data/raw/, no key needed)
	cd .. && uv run python -m lothian.build --out v1/web/public/data/lothian.json

cars: ## Road graph for the simulated cars: OSM roads from Overpass (cached), then web/public/data/roads.json
	$(PY) pipeline.fetch_osm_roads
	$(PY) pipeline.stage08_roads

economics: ## Congestion-impact constants (config/economics.yaml) to web/public/data/economics.json
	$(PY) pipeline.stage09_economics

demand: ## Festival demand by venue, date and 15-minute slot from the ticket extracts in ../dataset (aggregates only) to web/public/data/demand.json
	$(PY) pipeline.stage10_demand

accommodation: ## Licensed short-term-let beds per postcode (public council register, cached in data/raw/stl/); rerun `make tiles` to place them
	$(PY) pipeline.stage11_accommodation

transport: ## Festival travel assumptions (config/transport.yaml) to web/public/data/transport.json
	$(PY) pipeline.stage12_transport

fetch: ## Download the raw data for AREA (default pilot; AREA=full is several GB; cached; see DATA_SOURCES.md)
	$(PY) pipeline.fetch_overture
	$(PY) pipeline.fetch_osm
	$(PY) pipeline.fetch_osm_context
	$(PY) pipeline.fetch_lidar
	$(PY) pipeline.fetch_census

footprints: ## Stage 01: building footprints joined to OSM tags
	$(PY) pipeline.stage01_footprints
heights: ## Stage 02: per-building heights
	$(PY) pipeline.stage02_heights
infill: ## Stage 02b: buildings inferred for empty ground (docs/infill.md)
	$(PY) pipeline.stage02b_infill
use-class: ## Stage 03 (M2): building use class
	$(PY) pipeline.stage03_use_class
census: ## Stage 04 (M2): census residents and workers per output area
	$(PY) pipeline.stage04_census
allocate: ## Stage 05 (M2): allocate census totals to buildings
	$(PY) pipeline.stage05_allocate
tiles: ## Stage 06: building table and PMTiles for the web app (needs tippecanoe)
	$(PY) pipeline.stage06_tiles
calibrate: ## Stage 07 (M4, optional): calibrate profiles against footfall data
	$(PY) pipeline.stage07_calibrate
validate-heights: ## Check heights against docs/height_reference.csv and write docs/height_validation.md
	$(PY) pipeline.validate_heights
m1: fetch footprints heights infill tiles validate-heights ## Run the whole M1 pipeline: data, footprints, heights, infill, tiles, validation
city: fetch footprints heights infill tiles ## Same for the whole council area, without the pilot-only height validation: make city AREA=full
all: fetch footprints heights infill use-class census allocate tiles ## Run every stage in order (stages 03 to 05 are stubs while M2 is paused)

test: test-py test-web ## Run the Python tests, the web unit tests and the web typecheck
test-py: ## Python tests only
	uv run pytest -q
test-web: ## Web typecheck and unit tests only
	$(WEB) run typecheck
	$(WEB) test
test-e2e: ## Browser smoke test (needs install-browsers)
	$(WEB) run test:e2e

lint: ## Check Python style
	uv run ruff check .
	uv run ruff format --check .

web-dev: ## Start the web app (Vite uses the next free port if 5173 is taken)
	$(WEB) run dev
web-build: ## Production build of the web app into web/dist
	$(WEB) run build

clean: ## Remove build output and caches (raw data in data/ is kept)
	rm -rf web/dist web/test-results .pytest_cache .ruff_cache
