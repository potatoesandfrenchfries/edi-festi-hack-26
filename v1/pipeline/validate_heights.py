"""Validate building heights against published references and write docs/height_validation.md.

    uv run python -m pipeline.validate_heights

Two checks, reported separately because they answer different questions:
  1. Independent references (docs/height_reference.csv): published heights of named buildings.
  2. A cross-check of LiDAR heights against OSM `height` tags. The tags are NOT independent evidence (they are one of the
     model's own inputs) and are shown only to measure how often the two sources disagree.
"""

import csv
import itertools

import numpy as np
import pyarrow.parquet as pq
import rasterio
import shapely
import yaml
from pyproj import Transformer
from shapely.geometry import Point

from pipeline.common import RAW, ROOT
from pipeline.heights import measure
from pipeline.landmarks import match_footprint

MATCH_RADIUS_M = 5.0
TO_BNG = Transformer.from_crs(4326, 27700, always_xy=True)
SWEEP_ROOF = (90, 95, 99, 100)
SWEEP_GROUND = (10, 25, 50)


def passes(error, reference, tol_abs, tol_rel):
    """A height passes when it is within tol_abs metres or tol_rel of the reference, whichever is larger."""
    return abs(error) <= max(tol_abs, tol_rel * reference)


def _stats(errors, refs, tol_abs, tol_rel):
    errors, refs = np.asarray(errors), np.asarray(refs)
    ok = [passes(e, r, tol_abs, tol_rel) for e, r in zip(errors, refs, strict=True)]
    return {"n": len(errors), "mae": float(np.abs(errors).mean()), "bias": float(errors.mean()), "pass": sum(ok), "ok": ok}


def run():
    model = yaml.safe_load((ROOT / "config" / "model.yaml").read_text())
    cfg, val = model["heights"], model["validation"]
    tol_abs, tol_rel, required = val["tolerance_abs_m"], val["tolerance_rel"], val["required_share"]
    fps = pq.read_table(ROOT / "data" / "interim" / "footprints.parquet").to_pylist()
    hts = {r["id"]: r for r in pq.read_table(ROOT / "data" / "interim" / "heights.parquet").to_pylist()}
    geoms = [shapely.from_wkb(r["geom_wkb"]) for r in fps]
    tree = shapely.STRtree(geoms)
    with rasterio.open(RAW / "lidar" / "phase5_dsm_pilot.tif") as d, rasterio.open(RAW / "lidar" / "phase5_dtm_pilot.tif") as t:
        dsm, dtm, transform = d.read(1), t.read(1), d.transform

    def lidar_height(i, roof, ground):
        m = measure(
            dsm, dtm, transform, geoms[i], roof_percentile=roof, ground_percentile=ground, ring_width_m=cfg["perimeter_buffer_m"]
        )
        return m.height

    with open(ROOT / "docs" / "height_reference.csv") as f:
        refs = list(csv.DictReader(f))
    rows, unmatched = [], []
    for r in refs:
        i = match_footprint(Point(*TO_BNG.transform(float(r["lon"]), float(r["lat"]))), geoms, tree)
        if i is None:
            unmatched.append(r["name"])
            continue
        rows.append({**r, "i": i, "ref": float(r["ref_height_m"])})

    for row in rows:
        h = hts[fps[row["i"]]["id"]]
        # The automated result, before the curated landmark override: the override copies published heights, so checking it
        # against the same published heights would pass by construction.
        row.update(final=h["auto_height_m"], src=h["auto_height_src"], flag=None, area=fps[row["i"]]["footprint_area_m2"])
        row["override"] = h["height_m"] if h["height_src"] == "manual" else None
        row["lidar"] = lidar_height(row["i"], cfg["footprint_percentile"], cfg["ground_percentile"])
        row["peak"] = lidar_height(row["i"], 100, cfg["ground_percentile"])

    sweep = []
    for roof, ground in itertools.product(SWEEP_ROOF, SWEEP_GROUND):
        errs = [lidar_height(row["i"], roof, ground) - row["ref"] for row in rows]
        sweep.append((roof, ground, _stats(errs, [row["ref"] for row in rows], tol_abs, tol_rel)))

    final = _stats([row["final"] - row["ref"] for row in rows], [row["ref"] for row in rows], tol_abs, tol_rel)
    lidar = _stats([row["lidar"] - row["ref"] for row in rows], [row["ref"] for row in rows], tol_abs, tol_rel)

    # Cross-check against OSM tags (not independent evidence).
    pairs = [
        (r["osm_height_m"], hts[r["id"]]["lidar_height_m"])
        for r in fps
        if r["osm_height_m"] and hts[r["id"]]["lidar_height_m"] is not None
    ]
    tag_err = [lidar - tag for tag, lidar in pairs]
    tags = _stats(tag_err, [tag for tag, _ in pairs], tol_abs, tol_rel)
    worst = sorted(
        (
            (abs(l - tag), tag, l, r["osm_name"])
            for r in fps
            for tag, l in [(r["osm_height_m"], hts[r["id"]]["lidar_height_m"])]
            if tag and l is not None
        ),
        reverse=True,
    )[:6]

    all_h = np.array([h["height_m"] for h in hts.values()])
    summary = {
        "n": len(hts),
        "min": float(all_h.min()),
        "nonpositive": int((all_h <= 0).sum()),
        "missing": int(np.isnan(all_h).sum()),
        "pct": np.percentile(all_h, [5, 25, 50, 75, 95, 99]),
    }
    src = {}
    for h in hts.values():
        src[h["height_src"]] = src.get(h["height_src"], 0) + 1
    conf = {}
    for h in hts.values():
        conf[h["height_conf"]] = conf.get(h["height_conf"], 0) + 1
    flags = {}
    for h in hts.values():
        flags[h["height_flag"] or "none"] = flags.get(h["height_flag"] or "none", 0) + 1

    parts = pq.read_table(ROOT / "data" / "interim" / "landmark_parts.parquet").to_pylist()
    landmarks = []
    for r in fps:
        h = hts[r["id"]]
        if h["height_src"] == "manual":
            mine = [p["height_m"] for p in parts if p["parent_id"] == r["id"]]
            landmarks.append(
                (r["osm_name"] or "(unnamed)", h["auto_height_m"], h["height_m"], max(mine, default=h["height_m"]), len(mine))
            )
    landmarks.sort(key=lambda x: -x[3])
    write_report(
        cfg, val, rows, unmatched, final, lidar, sweep, tags, worst, summary, src, conf, flags, required, len(refs), landmarks
    )
    print(
        f"references matched {len(rows)}/{len(refs)}; automated pass {final['pass']}/{final['n']}; lidar-only pass {lidar['pass']}/{lidar['n']}"
    )


def write_report(
    cfg, val, rows, unmatched, final, lidar, sweep, tags, worst, summary, src, conf, flags, required, n_refs, landmarks
):
    tol = f"{val['tolerance_abs_m']:g} m or {val['tolerance_rel']:.0%}, whichever is larger"
    L = []
    a = L.append
    a("# Height validation\n")
    a("Generated by `pipeline/validate_heights.py`. Do not edit by hand; edit the script or the inputs and rerun.\n")
    a("## Summary\n")
    a(
        f"- **Independent references:** {n_refs} published heights (`docs/height_reference.csv`), of which {len(rows)} match a footprint. "
        f"The acceptance target is at least 30, so **the count target is not met**: open web sources give heights only for tall landmarks "
        f"(towers, spires, monuments) and none for ordinary buildings. More references have to come from the project owner (PLAN.md C16)."
    )
    a(f"- **Tolerance:** within {tol}. Required: at least {required:.0%} of references.")
    a(
        f"- **Automated pipeline height vs references:** {final['pass']}/{final['n']} within tolerance ({final['pass'] / final['n']:.0%}), "
        f"mean absolute error {final['mae']:.1f} m, bias {final['bias']:+.1f} m. This is the figure that measures the pipeline: it is the height "
        "before the curated landmark override below, and no reference is used to produce it."
    )
    a(
        f"- **Landmark override:** {len(landmarks)} landmarks are hand-listed in `config/landmarks.csv` and drawn as a body plus a stepped tower. "
        "Ten of them are the same buildings as the references, so their displayed heights match the references by construction. "
        "That makes them look right on the map but is **not** validation."
    )
    a(
        f"- **LiDAR-only height vs references:** {lidar['pass']}/{lidar['n']} within tolerance, mean absolute error {lidar['mae']:.1f} m, bias {lidar['bias']:+.1f} m."
    )
    a(
        f"- **Every building has a positive height:** {summary['n']} buildings, {summary['missing']} missing, {summary['nonpositive']} non-positive, minimum {summary['min']:.1f} m.\n"
    )
    a("## Method\n")
    a(
        f"Roof level is the {cfg['footprint_percentile']}th percentile of the 0.5 m DSM inside the footprint. Ground level is the "
        f"{cfg['ground_percentile']}th percentile of the DTM in a {cfg['perimeter_buffer_m']:g} m ring around the footprint. Height is roof minus ground. "
        f"A reference point is matched to the largest footprint within {MATCH_RADIUS_M:g} m of its coordinates; this rule was fixed before looking at results.\n"
    )
    a(
        "Reference heights are mostly to the **tip of a spire or tower**, whereas the pipeline measures a roof level that suits floor-area allocation. "
        "That difference is deliberate and is the main reason slender landmarks are under-measured (see the sweep).\n"
    )
    a("## Independent references\n")
    a("| Building | Reference m | Automated m | Source | LiDAR m | Peak m | Error m | Footprint m² | Pass |")
    a("|---|---:|---:|---|---:|---:|---:|---:|:--:|")
    for row, ok in zip(rows, final["ok"], strict=True):
        a(
            f"| {row['name']} | {row['ref']:.1f} | {row['final']:.1f} | {row['src']}{' (' + row['flag'] + ')' if row['flag'] else ''} | "
            f"{row['lidar']:.1f} | {row['peak']:.1f} | {row['final'] - row['ref']:+.1f} | {row['area']:.0f} | {'yes' if ok else 'no'} |"
        )
    for name in unmatched:
        a(f"| {name} | | | no footprint within {MATCH_RADIUS_M:g} m | | | | | n/a |")
    a(
        "\n*LiDAR m* uses the configured percentiles. *Peak m* is the DSM maximum minus ground, which approximates a tip height. "
        "*Automated m* is the height after the D7 merge and before any landmark override, so it can come from an OSM tag instead of LiDAR.\n"
    )
    a("## Roof and ground percentile sweep (LiDAR only, same references)\n")
    a("| Roof percentile | Ground percentile | Mean abs error m | Bias m | Within tolerance |")
    a("|---:|---:|---:|---:|---:|")
    for roof, ground, s in sweep:
        mark = " **(configured)**" if (roof, ground) == (cfg["footprint_percentile"], cfg["ground_percentile"]) else ""
        a(f"| {roof}{mark} | {ground} | {s['mae']:.1f} | {s['bias']:+.1f} | {s['pass']}/{s['n']} |")
    a(
        "\nHigher roof percentiles fit tall slender landmarks better but raise ordinary roofs too (chimneys, dormers, plant). On a random "
        "1,500-building sample the 99th percentile was a median 0.7 m above the 95th and the maximum 1.1 m above, with 5.6% and 14% of buildings "
        "more than 3 m higher respectively. All ten references are tall landmarks, so choosing the percentile on them alone would bias every "
        "other building upward.\n"
    )
    a("## Cross-check against OSM height tags (not independent)\n")
    a(
        f"{tags['n']} buildings carry a usable OSM `height` tag and a valid LiDAR height. {tags['pass']} ({tags['pass'] / tags['n']:.0%}) agree within "
        f"tolerance; LiDAR minus tag has mean absolute difference {tags['mae']:.1f} m and bias {tags['bias']:+.1f} m. "
        "OSM tags are a model input, so this shows how often the sources disagree, not which one is right. The largest disagreements:\n"
    )
    a("| Tag m | LiDAR m | Name |")
    a("|---:|---:|---|")
    for _, tag, lid, name in worst:
        a(f"| {tag:.1f} | {lid:.1f} | {name or ''} |")
    a(
        "\nSeveral of these are landmarks whose published heights match LiDAR rather than the tag (for example The Hub is tagged 15 m against "
        "a published 74 m spire). In this area the tags often look like the height of a sub-part, an eave or a rough default.\n"
    )
    a("## Landmark overrides (not validation)\n")
    a(
        "Each landmark is drawn as a main body (a percentile of its LiDAR heights) plus up to four nested tower parts that follow the surface "
        "model, topped at the published height where one is given (otherwise the LiDAR peak). Ground is taken at street level for the Balmoral Hotel "
        "because it stands above the Waverley cutting. Only listed buildings get this treatment, so cranes elsewhere are never turned into towers.\n"
    )
    a("| Landmark | Automated m | Body m | Tip m | Tower parts |")
    a("|---|---:|---:|---:|---:|")
    for name, auto, body, tip, n in landmarks:
        a(f"| {name} | {auto:.1f} | {body:.1f} | {tip:.1f} | {n} |")
    a("")
    a("## Whole-area result\n")
    a(f"Height percentiles (5, 25, 50, 75, 95, 99): {', '.join(f'{v:.1f}' for v in summary['pct'])} m.\n")
    a("| Source | Buildings |\n|---|---:|")
    for k, v in sorted(src.items(), key=lambda kv: -kv[1]):
        a(f"| {k} | {v} |")
    a("\n| Confidence | Buildings |\n|---|---:|")
    for k, v in sorted(conf.items(), key=lambda kv: -kv[1]):
        a(f"| {k} | {v} |")
    a("\n| Flag | Buildings |\n|---|---:|")
    for k, v in sorted(flags.items(), key=lambda kv: -kv[1]):
        a(f"| {k} | {v} |")
    a("\n## Known limitations\n")
    a("- **Slender towers and spires** on wide footprints are under-measured, by design (roof level, not tip).")
    a(
        "- **Valley edges:** a building above a cutting (Balmoral Hotel above Waverley station) gets a ground level from the low side, so its height "
        "is over-stated. Such sites are flagged `steep_terrain` and given medium confidence."
    )
    a("- **Trees** overhanging roofs raise the DSM, and demolished or new buildings since capture are not reflected.")
    a(
        "- **Capture date:** Phase 5 was flown in 2020 to 2022 at programme level; the date over Edinburgh is not confirmed (spike S2)."
    )
    a(
        "- **Reference set** is small and biased toward tall landmarks. Statements about ordinary buildings rest on the OSM cross-check only."
    )
    (ROOT / "docs" / "height_validation.md").write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    run()
