"""Curated landmarks: a main body plus a stepped tower or spire built from the LiDAR (library for stage 02).

A single extruded prism cannot show a church with a spire or a monument that narrows towards the top, and a roof-level
statistic misses the spire entirely. For a short, hand-picked list (config/landmarks.csv) the footprint is therefore split
into a body height and a few nested parts that follow the DSM. This is applied only to the listed buildings, so construction
cranes and other noise elsewhere are never treated as towers.
"""

import csv
from dataclasses import dataclass

import numpy as np
import shapely
from rasterio import features
from shapely.geometry import shape
from shapely.ops import unary_union

from pipeline.heights import NODATA, _window


@dataclass(frozen=True)
class Landmark:
    name: str
    lon: float
    lat: float
    tip_height_m: float | None  # published height of the top; None means use the LiDAR peak
    body_height_m: float | None  # None means a percentile of the LiDAR heights inside the footprint
    ground_lon: float | None  # optional street-level point, for sites above a cutting or on a slope
    ground_lat: float | None
    source: str


@dataclass(frozen=True)
class Part:
    polygon: shapely.Polygon
    height_m: float
    level: int


@dataclass(frozen=True)
class Built:
    body_height_m: float
    tip_height_m: float
    ground_z: float
    parts: list[Part]


def _num(value):
    return float(value) if value not in (None, "") else None


def load_landmarks(path):
    with open(path) as f:
        return [
            Landmark(
                r["name"], float(r["lon"]), float(r["lat"]), _num(r["tip_height_m"]), _num(r["body_height_m"]),
                _num(r["ground_lon"]), _num(r["ground_lat"]), r["source"],
            )
            for r in csv.DictReader(f)
        ]  # fmt: skip


def match_footprint(point, geoms, tree, radius=5.0):
    """Index of the largest footprint within `radius` of `point`, or None. Chosen in advance, not per building."""
    candidates = [i for i in tree.query(point.buffer(radius)) if geoms[i].distance(point) <= radius]
    return max(candidates, key=lambda i: geoms[i].area) if candidates else None


def ground_at(dtm, transform, easting, northing, radius_m=2.0):
    """Median DTM within `radius_m` of a point: a street-level ground reference."""
    disc = shapely.Point(easting, northing).buffer(radius_m)
    window = _window(transform, dtm.shape, disc.bounds)
    if window is None:
        return None
    rows, cols, win_transform = window
    sub = dtm[rows, cols]
    mask = features.rasterize([(disc, 1)], out_shape=sub.shape, transform=win_transform, fill=0, dtype="uint8").astype(bool)
    values = sub[mask]
    values = values[values != NODATA]
    return float(np.median(values)) if values.size else None


def build_landmark(dsm, transform, footprint, ground_z, landmark, *, body_percentile, steps, margin_m, min_part_m2, simplify_m):
    """Body height and nested tower parts for one landmark footprint, or None when the DSM has no data inside it.

    Body height is a percentile of (DSM - ground) inside the footprint unless the landmark gives one. Parts are the
    regions where the surface rises above the body, cut at `steps` evenly spaced levels up to the tip, each extruded to
    the middle of its band (the last one to the tip), which approximates a tapering spire with a few steps.
    """
    window = _window(transform, dsm.shape, footprint.bounds)
    if window is None:
        return None
    rows, cols, win_transform = window
    sub = dsm[rows, cols]
    inside = features.rasterize([(footprint, 1)], out_shape=sub.shape, transform=win_transform, fill=0, dtype="uint8").astype(
        bool
    )
    valid = inside & (sub != NODATA)
    if not valid.any():
        return None
    h = np.where(valid, sub - ground_z, -np.inf)
    body = landmark.body_height_m if landmark.body_height_m is not None else float(np.percentile(h[valid], body_percentile))
    tip = landmark.tip_height_m if landmark.tip_height_m is not None else float(h[valid].max())
    parts = []
    if tip > body + margin_m:
        edges = [body + margin_m] + [body + (tip - body) * j / steps for j in range(1, steps)]
        for level, low in enumerate(edges):
            top = tip if level == len(edges) - 1 else (low + edges[level + 1]) / 2
            region = h >= low
            if not region.any():
                continue
            polys = [shape(g) for g, v in features.shapes(region.astype("uint8"), mask=region, transform=win_transform) if v == 1]
            merged = unary_union(polys).buffer(0.25).simplify(simplify_m).intersection(footprint)
            for poly in getattr(merged, "geoms", [merged]):
                if poly.geom_type == "Polygon" and poly.area >= min_part_m2:
                    parts.append(Part(poly, float(top), level))
    return Built(body, tip, ground_z, parts)
