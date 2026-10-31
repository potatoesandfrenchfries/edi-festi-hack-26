# Edinburgh Festivals Hackathon 2026

## Data and pipeline

The festival ticket data lives in `dataset/`. Column
listings, sensitive-column handling and run instructions are in [dataset/README.md](dataset/README.md). The contents are sensitive and will not be available for public use

```
uv sync && cp .env.example .env
uv run python -m pipeline.run       # build parquet, then profile + covariance reports in reports/
uv run pytest                       # synthetic data
```

## Lothian bus simulator

A map of simulated Lothian buses on every route, built from public timetable data.
See [lothian/README.md](lothian/README.md).

```
uv run python -m lothian.build && uv run python -m http.server 8765 -d lothian/web
```
