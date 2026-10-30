"""Inferred buildings for ground that OSM and the footprint data leave empty (library for stage 02b).

Ground that no mapped building, street, railway, water, park or car park accounts for is split by what the LiDAR sees there:

* a smooth surface standing well above the ground is a real structure missing from the maps: it is drawn from the LiDAR;
* a rough surface standing above the ground is trees, and steep ground is a slope or rock face: both stay empty;
* bare, flat ground beside mapped buildings gets standard frontage buildings, plot by plot along the street, as tall as
  the mapped buildings around them. This is an assumption and is labelled as inferred, never as mapped.

Interior courtyards, gardens and lone patches are left empty: only ground within a plot depth of a street, and within reach of
mapped buildings, is filled.
"""

import math
from dataclasses import dataclass

import numpy as np
import shapely
from rasterio import features
from rasterio.transform import Affine
from shapely.geometry import MultiPoint, Polygon
from shapely.ops import unary_union

from pipeline.heights import NODATA
from pipeline.osm_context import Context

PIXEL_M2 = 0.25  # 0.5 m LiDAR pixels


@dataclass(frozen=True)
class Params:
    """The `infill` section of config/model.yaml plus the floor height."""

    fill_open_ground: bool
    min_blob_m2: float
    opening_m: float
    building_clearance_m: float
    max_slope_pct: float
    structure_min_height_m: float
    vegetation_roughness: float
    flat_max_height_m: float
    structure_min_m2: float
    structure_opening_m: float
    simplify_m: float
    frontage_depth_m: float
    plot_width_m: float
    party_gap_m: float
    min_plot_m2: float
    neighbour_reach_m: float
    neighbour_radius_m: float
    neighbour_min_height_m: float
    min_neighbours: int
    min_storeys: float
    max_storeys: float
    floor_height_m: float

    @classmethod
    def from_config(cls, model):
        cfg = {k: v for k, v in model["infill"].items() if k != "enabled"}
        return cls(**cfg, floor_height_m=model["floor_height_m"])


@dataclass(frozen=True)
class Surface:
    ndsm: np.ndarray  # DSM minus DTM in metres: height of whatever stands on the ground
    slope_pct: np.ndarray
    roughness: np.ndarray  # local standard deviation of the DSM in metres: trees are rough, roofs and ground are smooth
    transform: Affine


def _local_std(a, k=7, strip=1024):
    """Standard deviation of `a` over k x k windows, from integral images, computed in horizontal strips to bound memory.

    A strip is padded with the rows around it (edge-replicated at the array's own edges), so the result does not depend on the strip size.
    """
    pad = k // 2
    height = a.shape[0]
    out = np.empty(a.shape, dtype="float64")

    def window_sum(x):
        c = np.pad(np.cumsum(np.cumsum(x, axis=0), axis=1), ((1, 0), (1, 0)))
        return c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]

    for r0 in range(0, height, strip):
        r1 = min(r0 + strip, height)
        rows = np.clip(np.arange(r0 - pad, r1 + pad), 0, height - 1)
        padded = np.pad(a[rows].astype("float64"), ((0, 0), (pad, pad)), mode="edge")
        mean = window_sum(padded) / (k * k)
        out[r0:r1] = np.sqrt(np.maximum(window_sum(padded**2) / (k * k) - mean**2, 0.0))
    return out


def surface(dsm, dtm, transform, slope_step=4) -> Surface:
    """Height above ground, slope and roughness grids from the DSM and DTM (same grid, 0.5 m pixels, nodata -9999)."""
    valid = (dsm != NODATA) & (dtm != NODATA)
    ndsm = np.where(valid, dsm - dtm, 0.0)
    coarse = np.where(valid, dtm, 0.0)[::slope_step, ::slope_step]
    gy, gx = np.gradient(coarse, 0.5 * slope_step)
    slope = np.kron(np.hypot(gx, gy) * 100, np.ones((slope_step, slope_step)))[: dsm.shape[0], : dsm.shape[1]]
    return Surface(ndsm, slope, _local_std(np.where(valid, dsm, 0.0)), transform)


def _polygons(geom):
    return [g for g in getattr(geom, "geoms", [geom]) if g.geom_type == "Polygon" and not g.is_empty]


def _mask(geom, surf: Surface):
    return _mask_all([geom], surf)


def _mask_all(geoms, surf: Surface):
    """Pixels under any of `geoms`, rasterised in one call. A call per geometry would allocate a whole-tile grid each time."""
    geoms = list(geoms)
    if not geoms:
        return np.zeros(surf.ndsm.shape, bool)
    return features.rasterize(
        [(g, 1) for g in geoms], out_shape=surf.ndsm.shape, transform=surf.transform, fill=0, dtype="uint8"
    ).astype(bool)


def _values_in(geom, array, surf: Surface):
    """The values of `array` under one geometry, rasterised only inside the geometry's own bounding window."""
    rows, cols = array.shape
    minx, miny, maxx, maxy = geom.bounds
    inverse = ~surf.transform
    c0, r1 = inverse @ (minx, miny)
    c1, r0 = inverse @ (maxx, maxy)
    r0, r1, c0, c1 = max(math.floor(r0), 0), min(math.ceil(r1), rows), max(math.floor(c0), 0), min(math.ceil(c1), cols)
    if r1 <= r0 or c1 <= c0:
        return array[:0, :0].ravel()
    window = surf.transform @ Affine.translation(c0, r0)
    mask = features.rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0), transform=window, fill=0, dtype="uint8").astype(bool)
    return array[r0:r1, c0:c1][mask]


def _open(geom, radius):
    """Morphological opening (shrink by `radius`, then grow back), done piece by piece.

    The pieces of a raster-derived shape never interact in an opening, so the result is the same as opening the whole collection.
    Doing it as one geometry makes GEOS node thousands of pixel-edged pieces together, which took 90 s per tile instead of 3 s.
    """
    parts = _polygons(geom)
    if not parts:
        return Polygon()
    # quad_segs=16 is what geom.buffer() uses; the vectorised function defaults to 8, which rounds the corners differently.
    return unary_union(shapely.buffer(shapely.buffer(parts, -radius, quad_segs=16), radius, quad_segs=16))


def _polygonize(mask, surf: Surface):
    return unary_union(
        [
            shapely.geometry.shape(g)
            for g, v in features.shapes(mask.astype("uint8"), mask=mask, transform=surf.transform)
            if v == 1
        ]
        or [Polygon()]
    )


def empty_blobs(area, mapped, ctx: Context, p: Params):
    """Wide patches of ground left over once buildings, streets and OSM's non-building ground are taken away.

    Strips narrower than twice `opening_m` are verges and pavements, not plots, and are removed.
    """
    used = unary_union([mapped.buffer(p.building_clearance_m), ctx.street, ctx.unavailable()])
    gap = area.difference(used)
    opened = gap.buffer(-p.opening_m).buffer(p.opening_m).intersection(gap)
    return sorted((g for g in _polygons(opened) if g.area >= p.min_blob_m2), key=lambda g: (g.centroid.x, g.centroid.y))


def structures(blobs, surf: Surface, p: Params):
    """Real structures missing from the maps: smooth, tall, not steep. Returns [(polygon, height_m)]."""
    blob_mask = _mask_all(blobs, surf)
    mask = (
        blob_mask
        & (surf.ndsm >= p.structure_min_height_m)
        & (surf.roughness < p.vegetation_roughness)
        & (surf.slope_pct <= p.max_slope_pct)
    )
    geom = _open(_polygonize(mask, surf), p.structure_opening_m).simplify(p.simplify_m)
    out = []
    for poly in _polygons(unary_union([geom.intersection(b) for b in blobs])):
        if poly.area >= p.structure_min_m2:
            values = _values_in(poly, surf.ndsm, surf)
            height = float(np.percentile(values, 90)) if values.size else 0.0
            if height >= p.structure_min_height_m:
                out.append((poly, round(height, 1)))
    return out


def open_ground(blobs, surf: Surface, p: Params, taken):
    """Bare, flat ground inside the blobs, away from structures already drawn from the LiDAR."""
    blob_mask = _mask_all(blobs, surf)
    mask = blob_mask & (surf.ndsm < p.flat_max_height_m) & (surf.slope_pct <= p.max_slope_pct)
    geom = _open(_polygonize(mask, surf), 1.0)
    return geom.difference(taken.buffer(p.building_clearance_m)) if not taken.is_empty else geom


def frontage_plots(ground, ctx: Context, mapped, p: Params):
    """Plots along streets on `ground`: a strip one plot deep beside each frontage street, split every `plot_width_m`.

    A plot is kept only if it lies within `neighbour_reach_m` of a mapped building, so lone open patches are not filled.
    """
    zone = ground.intersection(ctx.frontage.buffer(p.frontage_depth_m)).difference(ctx.street)
    reach, near_street = mapped.buffer(p.neighbour_reach_m), ctx.frontage.buffer(3.0)
    shapely.prepare(reach)
    plots = []
    for strip in _polygons(zone):
        if strip.area < p.min_plot_m2 or strip.boundary.length == 0:
            continue
        seeds = []
        for line in getattr(strip.boundary.intersection(near_street), "geoms", [strip.boundary.intersection(near_street)]):
            if line.geom_type != "LineString" or line.length == 0:
                continue
            offsets = (
                np.arange(p.plot_width_m / 2, line.length, p.plot_width_m) if line.length > p.plot_width_m else [line.length / 2]
            )
            seeds += [line.interpolate(float(d)) for d in offsets]
        if not seeds:
            continue
        cells = shapely.voronoi_polygons(MultiPoint(seeds), extend_to=strip.envelope.buffer(100)) if len(seeds) > 1 else None
        for cell in cells.geoms if cells is not None else [strip]:
            for plot in _polygons(cell.intersection(strip).buffer(-p.party_gap_m / 2)):
                if plot.area >= p.min_plot_m2 and reach.intersects(plot):
                    plots.append(plot)
    return plots


class HeightLookup:
    """Height for an inferred building from the mapped buildings around it, kept within a believable range of storeys."""

    def __init__(self, geoms, heights, p: Params):
        self.points = shapely.centroid(np.array(geoms, dtype=object))
        self.tree = shapely.STRtree(self.points)
        self.heights = np.asarray(heights, dtype=float)
        self.p = p
        self.global_median = float(np.median(self.heights))

    def at(self, geom):
        centre = geom.centroid
        idx = [
            i
            for i in self.tree.query(centre.buffer(self.p.neighbour_radius_m))
            if self.points[i].distance(centre) <= self.p.neighbour_radius_m
        ]
        base = float(np.median(self.heights[idx])) if len(idx) >= self.p.min_neighbours else self.global_median
        lo, hi = self.p.min_storeys * self.p.floor_height_m, self.p.max_storeys * self.p.floor_height_m
        return round(min(max(base, lo), hi), 1), len(idx)


def reasons(blobs, surf: Surface, p: Params, drawn_structures, plots):
    """Area in hectares of the empty blobs by what happened to it. Sums to the blobs' pixel area."""
    blob_mask = _mask_all(blobs, surf)
    steep = blob_mask & (surf.slope_pct > p.max_slope_pct)
    tall = blob_mask & ~steep & (surf.ndsm >= p.structure_min_height_m)
    structure = _mask_all([g for g, _ in drawn_structures], surf)
    filled = _mask_all(plots, surf)
    out = {
        "steep ground, left empty": steep.sum(),
        "trees (tall and rough), left empty": (tall & (surf.roughness >= p.vegetation_roughness) & ~structure).sum(),
        "structures drawn from LiDAR": (structure & blob_mask).sum(),
        "bare ground filled with frontage plots": (filled & blob_mask).sum(),
    }
    out["other ground left empty (courtyards, lone patches, small remnants)"] = blob_mask.sum() - sum(out.values())
    return {k: round(float(v) * PIXEL_M2 / 1e4, 2) for k, v in out.items()}


def infer(area, mapped_geoms, height_geoms, heights, ctx: Context, surf: Surface, p: Params, own=None):
    """Inferred buildings as dicts (geom, height_m, basis, n_neighbours), plus the area accounting. Deterministic.

    `own` is for tiled runs: `area` then includes a buffer around the tile so patches are not cut at its edge, and only the
    patches whose centroid lies in `own` are kept, so each patch is handled by exactly one tile.

    `mapped_geoms` are every mapped footprint, used to find empty ground. `height_geoms` and `heights` are the ordinary mapped
    buildings (no sheds, no landmarks) that set the height of inferred ones.
    """
    mapped = unary_union(list(mapped_geoms))
    blobs = empty_blobs(area, mapped, ctx, p)
    if own is not None:
        blobs = [b for b in blobs if own.contains(b.centroid)]
    drawn = structures(blobs, surf, p)
    records = [{"geom": g, "height_m": h, "basis": "lidar", "n_neighbours": None} for g, h in drawn]
    plots = []
    if p.fill_open_ground and len(height_geoms):
        taken = unary_union([g for g, _ in drawn]) if drawn else Polygon()
        plots = frontage_plots(open_ground(blobs, surf, p, taken), ctx, mapped, p)
        lookup = HeightLookup(height_geoms, heights, p)
        for g in plots:
            h, n = lookup.at(g)
            records.append({"geom": g, "height_m": h, "basis": "osm_context", "n_neighbours": n})
    records.sort(key=lambda r: (r["basis"], round(r["geom"].centroid.x, 1), round(r["geom"].centroid.y, 1)))
    return records, reasons(blobs, surf, p, drawn, plots), blobs
