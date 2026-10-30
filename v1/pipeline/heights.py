"""Building heights: LiDAR surface minus local ground, and the source merge of design decision D7 (library for stage 02)."""

from dataclasses import dataclass

import numpy as np
from rasterio import features
from rasterio.transform import Affine
from shapely.geometry.base import BaseGeometry

NODATA = -9999.0


@dataclass(frozen=True)
class LidarMeasure:
    """What the DSM and DTM say about one footprint."""

    roof_z: float | None  # high percentile of the DSM inside the footprint
    ground_z: float | None  # low percentile of the DTM in a ring around the footprint
    ground_range: float | None  # spread of the ground ring (p90 - p10): large on steep terrain
    n_pixels: int
    valid_fraction: float

    @property
    def height(self):
        if self.roof_z is None or self.ground_z is None:
            return None
        return self.roof_z - self.ground_z


def _window(transform: Affine, shape, bounds):
    """Row/column slices covering `bounds` (clipped to the raster) and the transform of that window."""
    inv = ~transform
    (c0, r1), (c1, r0) = inv @ (bounds[0], bounds[1]), inv @ (bounds[2], bounds[3])
    r_lo, r_hi = max(int(np.floor(min(r0, r1))), 0), min(int(np.ceil(max(r0, r1))), shape[0])
    c_lo, c_hi = max(int(np.floor(min(c0, c1))), 0), min(int(np.ceil(max(c0, c1))), shape[1])
    if r_lo >= r_hi or c_lo >= c_hi:
        return None
    return slice(r_lo, r_hi), slice(c_lo, c_hi), transform @ Affine.translation(c_lo, r_lo)


def _values(raster, transform, geom: BaseGeometry, bounds):
    """Raster values whose pixel centres fall inside `geom`, plus the number of pixels the geometry covers."""
    window = _window(transform, raster.shape, bounds)
    if window is None or geom.is_empty:
        return np.empty(0), 0
    rows, cols, win_transform = window
    sub = raster[rows, cols]
    mask = features.rasterize([(geom, 1)], out_shape=sub.shape, transform=win_transform, fill=0, dtype="uint8").astype(bool)
    covered = int(mask.sum())
    values = sub[mask]
    return values[values != NODATA], covered


def measure(dsm, dtm, transform, footprint, *, roof_percentile=95.0, ground_percentile=10.0, ring_width_m=3.0) -> LidarMeasure:
    """DSM minus ground for one footprint (both arrays share `transform`, 0.5 m pixels, nodata -9999).

    Roof level is a high percentile of the DSM inside the footprint, which ignores chimneys' extremes and small gaps.
    Ground level is a low percentile of the DTM in a ring around the footprint, not the DTM under it. Under a building
    the DTM is interpolated, and on a slope the ground differs from side to side: the low percentile follows the downhill
    side, which is the side whose height a viewer actually sees. `ground_range` records how much the ground varies so
    that callers can treat steep sites with less confidence.
    """
    roof_vals, covered = _values(dsm, transform, footprint, footprint.bounds)
    ring = footprint.buffer(ring_width_m).difference(footprint)
    ground_vals, _ = _values(dtm, transform, ring, ring.bounds)
    if roof_vals.size == 0 or ground_vals.size == 0:
        return LidarMeasure(None, None, None, int(roof_vals.size), 0.0)
    p10, p90 = np.percentile(ground_vals, [10, 90])
    return LidarMeasure(
        roof_z=float(np.percentile(roof_vals, roof_percentile)),
        ground_z=float(np.percentile(ground_vals, ground_percentile)),
        ground_range=float(p90 - p10),
        n_pixels=int(roof_vals.size),
        valid_fraction=float(roof_vals.size / covered) if covered else 0.0,
    )


@dataclass(frozen=True)
class HeightResult:
    height_m: float
    src: str  # osm_tag | lidar | overture | floors | gba | default
    conf: str  # high | medium | low
    flag: str | None  # tag_lidar_disagree | steep_terrain | None


def disagree(a, b, abs_m, rel):
    """True when two heights differ by more than `abs_m` metres and by more than `rel` of the larger."""
    diff = abs(a - b)
    return diff > abs_m and diff > rel * max(a, b)


def merge_height(*, osm_height, lidar: LidarMeasure | None, overture_height, floors, floor_height_m, cfg) -> HeightResult:
    """Choose a height by design decision D7: OSM tag, LiDAR, Overture height, floors x floor height, (GBA), default.

    `cfg` is the `heights` section of config/model.yaml. The Global Building Atlas step is not wired up yet, so it is skipped.
    """
    lidar_h = lidar.height if lidar else None
    lidar_ok = (
        lidar_h is not None
        and lidar_h >= cfg["min_lidar_height_m"]
        and lidar.n_pixels >= cfg["min_lidar_pixels"]
        and lidar.valid_fraction >= cfg["min_valid_fraction"]
    )
    steep = bool(lidar_ok and lidar.ground_range is not None and lidar.ground_range > cfg["steep_range_m"])

    if osm_height:
        if lidar_ok and disagree(osm_height, lidar_h, cfg["disagreement_abs_m"], cfg["disagreement_rel"]):
            if cfg["on_disagreement"] == "prefer_lidar":
                return HeightResult(lidar_h, "lidar", "low", "tag_lidar_disagree")
            return HeightResult(osm_height, "osm_tag", "low", "tag_lidar_disagree")
        return HeightResult(osm_height, "osm_tag", "high" if lidar_ok else "medium", None)
    if lidar_ok:
        return HeightResult(lidar_h, "lidar", "medium" if steep else "high", "steep_terrain" if steep else None)
    if overture_height and overture_height > 0:
        return HeightResult(float(overture_height), "overture", "medium", None)
    if floors and floors > 0:
        return HeightResult(float(floors * floor_height_m), "floors", "low", None)
    return HeightResult(float(cfg["default_height_m"]), "default", "low", None)
