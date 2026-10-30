# Edinburgh presence map

Modelled (never live) estimates of people active in each Edinburgh building, by hour and day type. Read `DESIGN.md` for the model and `PLAN.md` for milestone scope and open questions.

## Commands

- `make help` lists every target. `make install` sets up Python 3.12 (uv) and the web app (npm).
- `make test` runs pytest, the web typecheck and the web unit tests. `make test-e2e` runs the browser smoke test (`make install-browsers` once).
- `make m1` runs the M1 pipeline end to end (needs tippecanoe); `make validate-heights` rewrites `docs/height_validation.md`.
- `make lint` checks Python style. `make fetch` downloads the pilot-area raw data into `data/raw/` (cached).
- Run a pipeline stage on its own with `uv run python -m pipeline.stageNN_name`.

## Rules

1. Work one milestone at a time. Run its acceptance checks and report what passed and what did not before starting the next.
2. Never commit credentials, API keys, or raw data. `.env` is gitignored; `.env.example` is committed. Every `VITE_` variable ends up in the public bundle, so it must never hold a secret.
3. Keep downloads scoped to Edinburgh (pilot bbox or council area), preferring windowed or filtered reads to whole-country files. There is no hard size limit, but report what was fetched. Ask before applying for gated data and never bypass access controls.
4. Record every dataset in `DATA_SOURCES.md` (URL, licence, access date, checksum) when it is added.
5. Label modelled values as estimates in code, UI and docs. Do not call modelled data "live" or "real-time".
6. No cost, price, rent or rateable-value fields anywhere. If a source has them, drop them in the first pipeline stage.
7. The pipeline is idempotent and deterministic. Cache raw downloads.
8. Every tunable lives in `config/` with a comment giving its origin: `placeholder`, `literature`, `calibrated` or `assumption`. `tests/test_config.py` enforces this.
9. If a "Verify" item in `DESIGN.md` section 4 turns out to be false, update the document and flag it instead of working around it.
10. Write small, tested functions, and add tests together with the code.

## Conventions

- Process in EPSG:27700; publish tiles in EPSG:4326.
- Python: ruff (line length 130). Web: strict TypeScript, no framework, exact-pinned dependencies.
- The Playwright smoke test uses port 5273 and never reuses a running server.
