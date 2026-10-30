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
