# Edinburgh Festivals Hackathon 2026

initial commit

## Data and pipeline

The festival ticket data lives in `dataset/` (git-ignored, sensitive: keep it local). Column
listings, sensitive-column handling and run instructions are in [dataset/README.md](dataset/README.md).

```
uv sync && cp .env.example .env     # set PIPELINE_SALT
uv run python -m pipeline.run       # build parquet, then profile + covariance reports in reports/
uv run pytest                       # runs on synthetic data only
```

## Lothian bus simulator

A map of simulated Lothian buses on every route, built from public timetable data (no API key).
See [lothian/README.md](lothian/README.md).

```
uv run python -m lothian.build && uv run python -m http.server 8765 -d lothian/web
```
