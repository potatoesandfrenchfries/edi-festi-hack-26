"""Run the pipeline:  uv run python -m pipeline.run [--tables eif,fringe] [--stages build,analyze]"""
from __future__ import annotations

import argparse

from . import analyze, build
from . import config as C


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tables", default=",".join(C.TABLES), help="comma-separated; default: all")
    p.add_argument("--stages", default="build,analyze")
    args = p.parse_args()

    tables = tuple(t for t in args.tables.split(",") if t)
    unknown = set(tables) - set(C.TABLES)
    if unknown:
        p.error(f"unknown table(s) {sorted(unknown)}; choose from {list(C.TABLES)}")
    stages = set(args.stages.split(","))

    if "build" in stages:
        build.run(tables)
    if "analyze" in stages:
        analyze.run(tables)


if __name__ == "__main__":
    main()
