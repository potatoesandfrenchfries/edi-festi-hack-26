"""Raw CSV -> typed, pseudonymised parquet tables.

Layers, all DuckDB views until the final COPY:
  <name>_raw    every column as trimmed text; blanks -> NULL; direct PII dropped,
                key columns replaced by a salted hash
  <name>_typed  per-column type inferred from a row sample (numeric / 0-1 flag /
                timestamp / minutes-since-midnight / text)
  <name>        typed + derived features; then written to parquet

Column names come from config.py; cell values are never printed or logged.
"""
from __future__ import annotations

import csv
import glob
import os
import re
import secrets
import sys

import duckdb

from . import config as C

SAMPLE_ROWS = 200_000
DATE_COVERAGE = 0.90  # a date column is only parsed if this share of its values match
NUMERIC_SHARE = 0.95
MAX_CATEGORIES = 200
FLAG = "TINYINT"  # 0/1 flag columns are typed TINYINT so rollups can find them

DATE_FORMATS = (
    None,  # DuckDB's own ISO-ish TIMESTAMP cast
    "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y", "%d/%m/%y %H:%M", "%d/%m/%y",
    "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M", "%d-%m-%Y", "%d-%b-%Y", "%d-%b-%y", "%d %b %Y",
    "%Y/%m/%d", "%Y%m%d", "%d/%m/%Y %I:%M %p", "%Y-%m-%d %H:%M",
)
TIME_FORMATS = ("%H:%M:%S", "%H:%M", "%I:%M %p", "%I:%M:%S %p", "%H%M")

TRUE = "('1', 'true', 'yes', 'y', 't')"
FALSE = "('0', 'false', 'no', 'n', 'f')"
BOOLISH = "('1', 'true', 'yes', 'y', 't', '0', 'false', 'no', 'n', 'f')"


def q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def lit(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.replace("﻿", "").lower()).strip("_")


def numeric_expr(c: str) -> str:
    return f"try_cast(replace(replace(replace({c}, '£', ''), ',', ''), '%', '') AS DOUBLE)"


def parse_expr(c: str, fmt: str | None) -> str:
    return f"try_cast({c} AS TIMESTAMP)" if fmt is None else f"try_strptime({c}, {lit(fmt)})"


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def get_salt() -> str:
    salt = os.environ.get("PIPELINE_SALT")
    if not salt:
        salt = secrets.token_hex(16)
        log("PIPELINE_SALT not set: using a random salt for this run. Hashed ids will not "
            "match across runs. Set PIPELINE_SALT in .env to make them stable.")
    return salt


# ---------------------------------------------------------------- raw layer
def create_raw(con: duckdb.DuckDBPyConnection, src: C.Source, salt: str) -> bool:
    files = sorted(glob.glob(str(C.DATASET_DIR / src.pattern)))
    if not files:
        log(f"[{src.name}] no files match {src.pattern!r}: skipped")
        return False
    arr = "[" + ", ".join(lit(f) for f in files) + "]"
    rel = (f"read_csv({arr}, header=true, all_varchar=true, union_by_name=true, "
           f"filename=true, null_padding=true, strict_mode=false, encoding={lit(src.encoding)})")
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {rel}").fetchall()]

    seen: dict[str, int] = {}
    parts = []
    for i, col in enumerate(cols):
        if col == "filename":
            continue
        n = norm(col) or f"col_{i}"
        if n in seen:
            seen[n] += 1
            n = f"{n}_{seen[n]}"
        else:
            seen[n] = 0
        if n in src.drop:
            continue
        e = f"nullif(trim({q(col)}), '')"
        if n in src.hash:
            e = f"substr(md5({lit(salt)} || {e}), 1, 16)"
        parts.append(f"{e} AS {q(n)}")
    parts.append("regexp_extract(filename, '[^/]*$') AS source_file")
    con.execute(f"CREATE OR REPLACE VIEW {src.name}_raw AS SELECT {', '.join(parts)} FROM {rel}")
    log(f"[{src.name}] {len(files)} file(s), {len(parts) - 1} columns kept")
    return True


# -------------------------------------------------------------- typed layer
def infer_parse(con, sample: str, col: str, formats) -> str | None:
    """Best coalesce() of parse attempts for `col`, or None if too few values parse."""
    c = q(col)
    nn = con.execute(f"SELECT count({c}) FROM {sample}").fetchone()[0]
    if nn == 0:
        return None
    hits = con.execute("SELECT " + ", ".join(f"count({parse_expr(c, f)})" for f in formats)
                       + f" FROM {sample}").fetchone()
    ranked = [f for f, h in sorted(zip(formats, hits), key=lambda t: -t[1]) if h > 0][:3]
    if not ranked:
        return None
    expr = "coalesce(" + ", ".join(parse_expr(c, f) for f in ranked) + ")"
    coverage = con.execute(f"SELECT count({expr}) FROM {sample}").fetchone()[0] / nn
    return expr if coverage >= DATE_COVERAGE else None


def decide_kind(name: str, nn: int, num: int, boo: int, dist: int, src: C.Source) -> str:
    if nn == 0:
        return "empty"
    if dist == 1 and re.search(src.presence, name):
        return "presence"
    if dist <= 2 and boo == nn:
        return "flag"
    if num / nn >= NUMERIC_SHARE and dist > 2:
        return "numeric"
    return "categorical" if dist <= MAX_CATEGORIES else "text"


def create_typed(con, src: C.Source, schema_rows: list[dict]) -> None:
    raw, sample = f"{src.name}_raw", f"{src.name}_sample"
    cols = [r[0] for r in con.execute(f"DESCRIBE {raw}").fetchall()]
    con.execute(f"CREATE OR REPLACE TEMP TABLE {sample} AS "
                f"SELECT * FROM {raw} USING SAMPLE {SAMPLE_ROWS} ROWS")

    fixed_text = set(src.ids) | set(src.hash) | {"source_file"}
    special = set(src.dates) | set(src.times)
    plain = [c for c in cols if c not in special and c not in fixed_text]

    stats: dict[str, tuple[int, int, int, int]] = {}
    if plain:
        sel = []
        for c in plain:
            cq = q(c)
            sel += [f"count({cq})", f"count({numeric_expr(cq)})",
                    f"count(*) FILTER (WHERE lower({cq}) IN {BOOLISH})",
                    f"approx_count_distinct({cq})"]
        row = con.execute(f"SELECT {', '.join(sel)} FROM {sample}").fetchone()
        stats = {c: tuple(row[4 * i: 4 * i + 4]) for i, c in enumerate(plain)}

    parts = []
    for c in cols:
        cq = q(c)
        if c in fixed_text:
            kind, expr = "text", cq
        elif c in special:
            fmts = DATE_FORMATS if c in src.dates else TIME_FORMATS + DATE_FORMATS
            parsed = infer_parse(con, sample, c, fmts)
            if parsed is None:
                log(f"[{src.name}] {c}: could not infer a date/time format: kept as text")
                kind, expr = "text", cq
            elif c in src.times:
                kind, expr = "minutes", f"(hour({parsed}) * 60 + minute({parsed}))::INTEGER"
            else:
                kind, expr = "timestamp", parsed
        else:
            nn, num, boo, dist = stats[c]
            kind = decide_kind(c, nn, num, boo, dist, src)
            expr = {
                "numeric": numeric_expr(cq),
                "flag": (f"(CASE WHEN lower({cq}) IN {TRUE} THEN 1 "
                         f"WHEN lower({cq}) IN {FALSE} THEN 0 END)::{FLAG}"),
                "presence": f"(CASE WHEN {cq} IS NULL THEN 0 ELSE 1 END)::{FLAG}",
            }.get(kind, cq)
            schema_rows.append({"table": src.name, "column": c, "kind": kind, "sample_non_null": nn,
                                "sample_numeric": num, "sample_boolish": boo, "sample_distinct": dist})
            if kind == "empty":
                continue
        if c in fixed_text or c in special:
            schema_rows.append({"table": src.name, "column": c, "kind": kind})
        parts.append(f"{expr} AS {cq}")
    con.execute(f"CREATE OR REPLACE VIEW {src.name}_typed AS SELECT {', '.join(parts)} FROM {raw}")


def create_derived(con, src: C.Source) -> None:
    have = {r[0] for r in con.execute(f"DESCRIBE {src.name}_typed").fetchall()}
    extra = []
    for f in src.derived:
        missing = [r for r in f.requires if r not in have]
        if missing:
            log(f"[{src.name}] derived {f.name!r} skipped: missing/untyped {missing}")
            continue
        extra.append(f"{f.sql} AS {q(f.name)}")
    sel = "*" + "".join(", " + e for e in extra)
    con.execute(f"CREATE OR REPLACE VIEW {src.name} AS SELECT {sel} FROM {src.name}_typed")


# ------------------------------------------------------------------ rollups
def create_rollup(con, r: C.Rollup) -> None:
    cols = con.execute(f"DESCRIBE {r.base}").fetchall()
    have = {c[0] for c in cols}
    if r.key not in have:
        log(f"[{r.name}] key {r.key!r} not in {r.base}: skipped")
        return
    key = q(r.key)
    joins = "".join(f" LEFT JOIN {j} USING ({key})" for j in r.join)
    if r.group:
        parts = [key]
        for f in r.features:
            missing = [x for x in f.requires if x not in have]
            if missing:
                log(f"[{r.name}] {f.name!r} skipped: missing {missing}")
                continue
            parts.append(f"{f.sql} AS {q(f.name)}")
        if r.flags_max:
            parts += [f"max({q(c[0])}) AS {q(c[0])}" for c in cols if c[1] == FLAG and c[0] != r.key]
        sql = (f"SELECT {', '.join(parts)} FROM {r.base} WHERE {key} IS NOT NULL "
               f"GROUP BY {key}")
        sql = f"SELECT * FROM ({sql}){joins}" if joins else sql
    else:
        sql = f"SELECT * FROM {r.base}{joins}"
    con.execute(f"CREATE OR REPLACE VIEW {r.name} AS {sql}")


# ---------------------------------------------------------------- run stage
def materialise(con, name: str) -> None:
    C.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    path = C.PROCESSED_DIR / f"{name}.parquet"
    con.execute(f"COPY (SELECT * FROM {name}) TO {lit(str(path))} (FORMAT parquet, COMPRESSION zstd)")
    # later layers read the parquet instead of re-parsing the CSV
    con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_parquet({lit(str(path))})")
    n = con.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
    log(f"[{name}] wrote {path.name}: {n:,} rows")


def run(tables: tuple[str, ...] | None = None) -> list[str]:
    """Build the requested tables (default: all). Returns the names written."""
    wanted = set(tables or C.TABLES)
    salt = get_salt()
    con = duckdb.connect()
    schema_rows: list[dict] = []
    built: list[str] = []
    available: set[str] = set()

    for src in C.SOURCES:
        if not create_raw(con, src, salt):
            continue
        create_typed(con, src, schema_rows)
        create_derived(con, src)
        available.add(src.name)
        if src.name in wanted:
            materialise(con, src.name)
            built.append(src.name)

    for r in C.ROLLUPS:
        deps = (r.base, *r.join)
        if not all(d in available for d in deps):
            log(f"[{r.name}] skipped: needs {[d for d in deps if d not in available]}")
            continue
        create_rollup(con, r)
        available.add(r.name)
        if r.name in wanted:
            materialise(con, r.name)
            built.append(r.name)

    if schema_rows:
        C.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        fields = ["table", "column", "kind", "sample_non_null", "sample_numeric",
                  "sample_boolish", "sample_distinct"]
        with open(C.REPORTS_DIR / "schema_inference.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(schema_rows)
    return built
