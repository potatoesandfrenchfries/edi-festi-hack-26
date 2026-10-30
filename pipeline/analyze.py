"""Profile, covariance/correlation and segment summaries for the built tables.

Reads only the parquet written by build.py and writes aggregates to
reports/<table>/. No output ever contains a row, an id, or a count below
config.MIN_CELL.
"""
from __future__ import annotations

import itertools
import sys

import duckdb
import numpy as np
import pandas as pd

from . import config as C
from .build import lit, q

MIN_ROWS = 100  # a numeric column needs this many non-null values to enter the matrices
MAX_NULL_RATE = 0.98
MAX_COV_COLS = 60  # keeps the pairwise query bounded on very wide tables
MIN_PAIR_N = max(30, C.MIN_CELL)
MAX_LEVELS_DISTINCT = 50
NEAR_DUPLICATE = 0.95
NUMERIC_TYPES = {"TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT",
                 "UINTEGER", "UBIGINT", "FLOAT", "DOUBLE", "REAL"}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def is_numeric(dtype: str) -> bool:
    return dtype in NUMERIC_TYPES or dtype.startswith("DECIMAL")


def md_table(df: pd.DataFrame, floatfmt: str = "{:.3f}") -> str:
    if df.empty:
        return "_none_\n"
    def cell(v):
        if isinstance(v, float):
            return "" if np.isnan(v) else floatfmt.format(v)
        return str(v)
    head = "| " + " | ".join(map(str, df.columns)) + " |\n"
    rule = "|" + "|".join("---" for _ in df.columns) + "|\n"
    rows = "".join("| " + " | ".join(cell(v) for v in r) + " |\n" for r in df.itertuples(index=False))
    return head + rule + rows


def profile(con, schema: list[tuple[str, str]], n_rows: int) -> pd.DataFrame:
    sel = []
    for name, dtype in schema:
        c = q(name)
        sel += [f"count({c})", f"approx_count_distinct({c})"]
        if is_numeric(dtype):
            d = f"CAST({c} AS DOUBLE)"
            sel += [f"avg({d})", f"stddev_samp({d})", f"quantile_cont({d}, 0.01)",
                    f"quantile_cont({d}, 0.5)", f"quantile_cont({d}, 0.99)"]
    row = list(con.execute(f"SELECT {', '.join(sel)} FROM t").fetchone())
    out, i = [], 0
    for name, dtype in schema:
        rec = {"column": name, "type": dtype, "non_null": row[i], "null_rate": 1 - row[i] / n_rows,
               "approx_distinct": row[i + 1]}
        i += 2
        if is_numeric(dtype):
            rec.update(zip(("mean", "std", "p01", "median", "p99"), row[i:i + 5]))
            i += 5
        out.append(rec)
    return pd.DataFrame(out)


def levels(con, prof: pd.DataFrame) -> pd.DataFrame:
    """Value counts for low-cardinality text columns; levels under MIN_CELL are dropped."""
    out = []
    low = prof[(prof["type"] == "VARCHAR") & (prof["approx_distinct"] <= MAX_LEVELS_DISTINCT)
               & (prof["approx_distinct"] > 0)]
    for col in low["column"]:
        c = q(col)
        df = con.execute(
            f"SELECT {c} AS level, count(*) AS n FROM t WHERE {c} IS NOT NULL "
            f"GROUP BY 1 HAVING count(*) >= {C.MIN_CELL} ORDER BY n DESC LIMIT 15").df()
        df.insert(0, "column", col)
        out.append(df)
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame(columns=["column", "level", "n"])


def pick_numeric(prof: pd.DataFrame) -> list[str]:
    ok = prof[prof["type"].map(is_numeric) & (prof["non_null"] >= MIN_ROWS)
              & (prof["null_rate"] <= MAX_NULL_RATE) & (prof["std"].fillna(0) > 0)]
    return list(ok.sort_values("non_null", ascending=False)["column"].head(MAX_COV_COLS))


def pairwise(con, cols: list[str], std: dict[str, float]):
    """Sample covariance / Pearson correlation / pair counts, pairwise-complete."""
    pairs = list(itertools.combinations(cols, 2))
    sel = []
    for a, b in pairs:
        qa, qb = q(a), q(b)
        sel += [f"covar_samp({qa}, {qb})", f"corr({qa}, {qb})", f"regr_count({qa}, {qb})"]
    row = con.execute(f"SELECT {', '.join(sel)} FROM num").fetchone() if sel else []
    cov = pd.DataFrame(np.nan, index=cols, columns=cols)
    cor, cnt = cov.copy(), cov.copy()
    for k, (a, b) in enumerate(pairs):
        c, r, n = row[3 * k: 3 * k + 3]
        if n is None or n < MIN_PAIR_N:
            continue
        cov.loc[a, b] = cov.loc[b, a] = c
        cor.loc[a, b] = cor.loc[b, a] = r
        cnt.loc[a, b] = cnt.loc[b, a] = n
    for a in cols:
        cov.loc[a, a] = std[a] ** 2
        cor.loc[a, a] = 1.0
    long = [{"a": a, "b": b, "n": cnt.loc[a, b], "cov": cov.loc[a, b], "corr": cor.loc[a, b]}
            for a, b in pairs if not np.isnan(cor.loc[a, b])]
    long = pd.DataFrame(long, columns=["a", "b", "n", "cov", "corr"])
    if not long.empty:
        long = long.reindex(long["corr"].abs().sort_values(ascending=False).index).reset_index(drop=True)
    return cov, cor, long


def heatmap(cor: pd.DataFrame, path) -> None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return
    k = len(cor)
    fig, ax = plt.subplots(figsize=(max(6, 0.32 * k + 3), max(5, 0.32 * k + 2)))
    im = ax.imshow(cor.to_numpy(dtype=float), vmin=-1, vmax=1, cmap="RdBu_r")
    ax.set_xticks(range(k), cor.columns, rotation=90, fontsize=6)
    ax.set_yticks(range(k), cor.index, fontsize=6)
    fig.colorbar(im, ax=ax, shrink=0.7, label="Pearson r")
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)


def segments(con, spec: C.Analysis, have: set[str], out_dir) -> dict[str, pd.DataFrame]:
    metrics = [m for m in spec.segment_metrics if m in have]
    result = {}
    for by in spec.segment_by:
        if by not in have:
            continue
        aggs = "".join(f", sum(CAST({q(m)} AS DOUBLE)) AS {q(m + '_sum')}, avg(CAST({q(m)} AS DOUBLE)) AS {q(m + '_mean')}"
                       for m in metrics)
        df = con.execute(
            f"SELECT {q(by)} AS level, count(*) AS rows{aggs} FROM t WHERE {q(by)} IS NOT NULL "
            f"GROUP BY 1 HAVING count(*) >= {C.MIN_CELL} ORDER BY rows DESC LIMIT 200").df()
        df.to_csv(out_dir / f"segments_{by}.csv", index=False)
        result[by] = df
    return result


def run_table(name: str) -> bool:
    path = C.PROCESSED_DIR / f"{name}.parquet"
    if not path.exists():
        log(f"[{name}] no parquet at {path}: run the build stage first")
        return False
    out = C.REPORTS_DIR / name
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"CREATE VIEW t AS SELECT * FROM read_parquet({lit(str(path))})")
    schema = [(r[0], r[1]) for r in con.execute("DESCRIBE t").fetchall()]
    n_rows = con.execute("SELECT count(*) FROM t").fetchone()[0]

    prof = profile(con, schema, n_rows)
    prof.to_csv(out / "profile.csv", index=False)
    lev = levels(con, prof)
    lev.to_csv(out / "category_levels.csv", index=False)

    cols = pick_numeric(prof)
    if len(cols) >= 2:
        con.execute("CREATE VIEW num AS SELECT " + ", ".join(f"CAST({q(c)} AS DOUBLE) AS {q(c)}" for c in cols)
                    + " FROM t")
        std = dict(zip(prof["column"], prof["std"]))
        cov, cor, pairs = pairwise(con, cols, std)
        cov.to_csv(out / "covariance.csv")
        cor.to_csv(out / "correlation.csv")
        pairs.to_csv(out / "pairs.csv", index=False)
        heatmap(cor, out / "correlation.png")
    else:
        cov = cor = pairs = pd.DataFrame()

    seg = {}
    have = {c for c, _ in schema}
    for spec in C.ANALYSIS:
        if spec.table == name:
            seg = segments(con, spec, have, out)

    write_report(out / "REPORT.md", name, n_rows, prof, cols, pairs, seg)
    log(f"[{name}] report -> {out}")
    return True


def write_report(path, name, n_rows, prof, cols, pairs, seg) -> None:
    numeric = prof[prof["type"].map(is_numeric)]
    L = [f"# {name}\n",
         f"{n_rows:,} rows, {len(prof)} columns ({len(numeric)} numeric, "
         f"{(prof['type'] == 'VARCHAR').sum()} text, {len(prof) - len(numeric) - (prof['type'] == 'VARCHAR').sum()} other).\n",
         f"Counts under {C.MIN_CELL} are suppressed. Pairs with fewer than {MIN_PAIR_N} complete "
         "observations are omitted.\n"]

    sparse = prof[prof["null_rate"] > 0.5].sort_values("null_rate", ascending=False)
    L += ["## Mostly-empty columns (> 50% null)\n",
          md_table(sparse[["column", "null_rate"]].head(25)), ""]

    L += [f"## Covariance / correlation\n",
          f"{len(cols)} numeric columns entered the matrices (>= {MIN_ROWS} non-null values, non-constant, "
          f"<= {MAX_NULL_RATE:.0%} null; capped at {MAX_COV_COLS}). Covariances are pairwise-complete, "
          "so they are not on a common sample and the matrix need not be positive semi-definite. "
          "0/1 flags give point-biserial correlations. Covariance is scale-dependent; read the "
          "correlation matrix to compare strengths. Files: `covariance.csv`, `correlation.csv`, "
          "`pairs.csv`, `correlation.png`.\n"]
    if pairs is not None and len(pairs):
        top = pairs.head(15)[["a", "b", "n", "corr", "cov"]]
        L += ["### Strongest relationships (by |r|)\n", md_table(top), ""]
        dup = pairs[pairs["corr"].abs() >= NEAR_DUPLICATE][["a", "b", "corr"]]
        L += [f"### Near-duplicates (|r| >= {NEAR_DUPLICATE})\n",
              "These carry almost the same information; many will be derived-from-each-other "
              "(e.g. a total and its per-unit value). Drop one before modelling.\n", md_table(dup.head(25)), ""]
    else:
        L += ["_Not enough numeric columns for a matrix._\n"]

    for by, df in seg.items():
        L += [f"## By `{by}`\n", md_table(df.head(15)), ""]

    L += ["## Reading this\n",
          "- Correlation is not causation, and with this many columns some strong pairs are structural "
          "(one column is built from the other).\n",
          "- Columns with high null rates are mostly event- or channel-specific (e.g. per-band base "
          "prices); their correlations describe only the rows where both exist.\n"]
    path.write_text("\n".join(str(x) for x in L))


def run(tables: tuple[str, ...] | None = None) -> list[str]:
    done = []
    for name in tables or C.TABLES:
        if run_table(name):
            done.append(name)
    return done
