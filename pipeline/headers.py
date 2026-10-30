"""Regenerate the column listing in dataset/README.md.

Opens each CSV and reads its FIRST LINE ONLY. No data rows are read.
    uv run python -m pipeline.headers
"""
from __future__ import annotations

import csv

from . import config as C

START, END = "<!-- headers:start -->", "<!-- headers:end -->"

# (glob, same_layout): same_layout=True means the files are yearly extracts of one table
FILES = {
    "EIF (Edinburgh International Festival), one file per year": ("EIF 2026/*20?? full set.csv", True),
    "Fringe 2026": ("Fringe 2026/*.csv", False),
    "Tattoo 2026 (Royal Edinburgh Military Tattoo)": ("Tattoo 2026/*.csv", False),
}


def read_header(path) -> list[str]:
    with open(path, "rb") as f:
        line = f.readline()  # one line of raw bytes, nothing else is read
    return next(csv.reader([line.decode("utf-8-sig", errors="replace")]))


def listing(cols: list[str]) -> str:
    return "\n".join(f"{i}. `{c.strip()}`" for i, c in enumerate(cols, 1)) + "\n"


def variants(headers: dict) -> list[str]:
    """One listing for the layout shared by most files, then how the others differ."""
    files = list(headers)
    base = headers[files[-1]]
    same = [f.name for f in files if headers[f] == base]
    out = [f"{len(base)} columns in {', '.join(f'`{n}`' for n in same)}:\n", listing(base)]
    for f, h in headers.items():
        if h == base:
            continue
        extra = [c.strip() for c in h if c not in base]
        missing = [c.strip() for c in base if c not in h]
        out.append(f"`{f.name}` has {len(h)} columns: adds {extra or 'nothing'}, "
                   f"lacks {missing or 'nothing'}"
                   f"{' (same columns, different order)' if sorted(h) == sorted(base) else ''}.\n")
    return out


def section() -> str:
    out = []
    for title, (pattern, same_layout) in FILES.items():
        files = sorted(C.DATASET_DIR.glob(pattern))
        out.append(f"### {title}\n")
        if not files:
            out.append("_no files found_\n")
        elif same_layout and len(files) > 1:
            out += variants({f: read_header(f) for f in files})
        else:
            for f in files:
                h = read_header(f)
                out += [f"`{f.name}`: {len(h)} columns:\n", listing(h)]
    return "\n".join(out)


def main() -> None:
    readme = C.DATASET_DIR / "README.md"
    text = readme.read_text()
    head, _, rest = text.partition(START)
    _, _, tail = rest.partition(END)
    readme.write_text(f"{head}{START}\n\n{section()}\n{END}{tail}")
    print(f"updated {readme}")


if __name__ == "__main__":
    main()
