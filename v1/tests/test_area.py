import json

import numpy as np
import pyarrow as pa
import pytest
import shapely
from pyproj import Transformer

from pipeline import common
from pipeline.common import ROOT, area, lidar_path, merge_elements, overpass_boxes, work_tiles
from pipeline.footprints import build_footprints
from pipeline.osm_context import elements_in
from pipeline.stage02_heights import landmarks_by_tile, split_by_tile

FULL = area("full")
TO_WGS84 = Transformer.from_crs(27700, 4326, always_xy=True)


def test_the_pilot_is_a_single_tile_whose_core_is_its_box_and_keeps_its_original_file_names():
    (tile,) = work_tiles("pilot")
    assert tile.core == tuple(area("pilot")["bbox_bng"])
    buffer = area("pilot")["lidar_buffer_m"]
    assert tile.read == (tile.core[0] - buffer, tile.core[1] - buffer, tile.core[2] + buffer, tile.core[3] + buffer)
    assert lidar_path("dsm", tile, "pilot").name == "phase5_dsm_pilot.tif"
    assert lidar_path("dtm", tile, "pilot").name == "phase5_dtm_pilot.tif"


def test_the_full_area_tiles_are_unique_aligned_and_inside_the_area_box():
    tiles = work_tiles("full")
    size = json.loads((ROOT / "config" / "full_tiles.json").read_text())["tile_m"]
    assert len(tiles) == len({t.name for t in tiles}) > 40
    west, south, east, north = FULL["bbox_bng"]
    for tile in tiles:
        assert tile.core[0] % size == 0 and tile.core[1] % size == 0
        assert tile.core[2] - tile.core[0] == tile.core[3] - tile.core[1] == size
        assert (
            tile.core[2] > west and tile.core[0] < east and tile.core[3] > south and tile.core[1] < north
        )  # touches the council box


def test_the_full_area_contains_the_pilot_so_every_landmark_has_a_tile():
    pilot = area("pilot")["bbox_bng"]
    tiles = work_tiles("full")
    for corner in ((pilot[0], pilot[1]), (pilot[2] - 1, pilot[3] - 1)):
        assert any(t.core[0] <= corner[0] < t.core[2] and t.core[1] <= corner[1] < t.core[3] for t in tiles)
    placed = landmarks_by_tile(tiles)
    assert sum(len(v) for v in placed.values()) == len({lm for v in placed.values() for lm in v}) >= 10


def test_full_area_lidar_files_are_named_per_tile():
    tiles = work_tiles("full")
    names = {lidar_path("dsm", t, "full").name for t in tiles}
    assert len(names) == len(tiles) and all(n.startswith("phase5_dsm_full_E") for n in names)


def test_area_wgs84_box_covers_all_four_corners_of_the_grid_box():
    for name in ("full",):  # the pilot's box was defined from two corners, and test_config pins that
        cfg = area(name)
        west, south, east, north = cfg["bbox_wgs84"]
        e0, n0, e1, n1 = cfg["bbox_bng"]
        for x in (e0, e1):
            for y in (n0, n1):
                lon, lat = TO_WGS84.transform(x, y)
                assert west - 2e-5 <= lon <= east + 2e-5 and south - 2e-5 <= lat <= north + 2e-5


def test_the_pilot_is_one_overpass_box_and_the_city_is_many_that_cover_every_tile():
    assert overpass_boxes("pilot") == [
        (
            area("pilot")["bbox_wgs84"][1],
            area("pilot")["bbox_wgs84"][0],
            area("pilot")["bbox_wgs84"][3],
            area("pilot")["bbox_wgs84"][2],
        )
    ]
    boxes = overpass_boxes("full")
    assert 10 < len(boxes) < 40
    for tile in work_tiles("full"):
        lon, lat = TO_WGS84.transform((tile.core[0] + tile.core[2]) / 2, (tile.core[1] + tile.core[3]) / 2)
        assert any(s <= lat <= n and w <= lon <= e for s, w, n, e in boxes)


def test_merge_elements_keeps_each_osm_object_once_in_a_stable_order():
    a = {"elements": [{"type": "way", "id": 2, "tags": {"a": "1"}}, {"type": "node", "id": 9}]}
    b = {"elements": [{"type": "way", "id": 2, "tags": {"a": "1"}}, {"type": "way", "id": 1}]}
    merged = merge_elements([a, b])
    assert [(e["type"], e["id"]) for e in merged] == [("node", 9), ("way", 1), ("way", 2)]
    assert merged == merge_elements([b, a]) or [(e["type"], e["id"]) for e in merge_elements([b, a])] == [
        ("node", 9),
        ("way", 1),
        ("way", 2),
    ]


def test_elements_in_selects_by_extent():
    inside = {"type": "way", "id": 1, "bounds": {"minlon": -3.2, "maxlon": -3.19, "minlat": 55.95, "maxlat": 55.96}}
    outside = {"type": "way", "id": 2, "bounds": {"minlon": -3.5, "maxlon": -3.4, "minlat": 55.8, "maxlat": 55.81}}
    straddling = {"type": "way", "id": 3, "bounds": {"minlon": -3.3, "maxlon": -3.1, "minlat": 55.9, "maxlat": 56.0}}
    node = {"type": "node", "id": 4, "lat": 55.955, "lon": -3.195}
    relation = {"type": "relation", "id": 5, "members": [{"geometry": [{"lat": 55.955, "lon": -3.195}]}]}
    got = elements_in([inside, outside, straddling, node, relation], -3.21, 55.94, -3.18, 55.97)
    assert [e["id"] for e in got] == [1, 3, 4, 5]


def _footprint_rows(points):
    """Minimal Overture rows: a 10 m square in BNG around each point, as WGS84 WKB."""
    rows = []
    for i, (e, n) in enumerate(points):
        ring = [TO_WGS84.transform(e + dx, n + dy) for dx, dy in ((0, 0), (10, 0), (10, 10), (0, 10), (0, 0))]
        rows.append({"id": f"b{i}", "height": None, "num_floors": None, "subtype": None, "class": None, "is_underground": False,
                     "sources": None, "wkb": shapely.to_wkb(shapely.Polygon(ring))})  # fmt: skip
    return rows


def test_footprints_belong_to_exactly_one_of_several_tiles_and_outside_ones_are_dropped():
    # Two touching boxes in Edinburgh; the second building's centre is on the seam and must be counted once.
    origin_e, origin_n = 325000, 673000
    boxes = [
        [origin_e, origin_n, origin_e + 1000, origin_n + 1000],
        [origin_e + 1000, origin_n, origin_e + 2000, origin_n + 1000],
    ]
    rows = _footprint_rows(
        [
            (origin_e + 100, origin_n + 100),
            (origin_e + 995, origin_n + 100),
            (origin_e + 1500, origin_n + 500),
            (origin_e + 5000, origin_n),
        ]
    )
    table, dropped = build_footprints(rows, {}, boxes, min_area_m2=4.0)
    assert sorted(table["id"].to_pylist()) == ["b0", "b1", "b2"]
    assert dropped["outside_area"] == 1
    single, _ = build_footprints(rows, {}, boxes[0], min_area_m2=4.0)  # one plain box still works
    assert single["id"].to_pylist() == ["b0"]  # b1's centre is exactly on the seam, so only the second box owns it


def test_split_by_tile_gives_every_footprint_to_exactly_one_tile():
    tiles = work_tiles("full")[:2]
    e, n = tiles[0].core[0] + 100, tiles[0].core[1] + 100
    e2, n2 = tiles[1].core[0] + 100, tiles[1].core[1] + 100
    geoms = [shapely.box(e, n, e + 10, n + 10), shapely.box(e2, n2, e2 + 10, n2 + 10)]
    table = pa.Table.from_pylist([{"id": f"x{i}", "geom_wkb": shapely.to_wkb(g)} for i, g in enumerate(geoms)])
    parts = split_by_tile(table, tiles)
    assert [p.num_rows for _, p in parts] == [1, 1]


def test_split_by_tile_refuses_footprints_outside_every_tile():
    table = pa.Table.from_pylist([{"id": "far", "geom_wkb": shapely.to_wkb(shapely.box(0, 0, 10, 10))}])
    with pytest.raises(AssertionError, match="outside every work tile"):
        split_by_tile(table, work_tiles("full")[:2])


def test_scoped_paths_keep_the_pilot_where_it_was(monkeypatch):
    base = ROOT / "data" / "interim"
    monkeypatch.setattr(common, "AREA", "pilot")
    assert common.scoped(base) == base
    monkeypatch.setattr(common, "AREA", "full")
    assert common.scoped(base) == base / "full"


def test_numpy_is_importable_for_tile_masks():
    assert np.array([1]).sum() == 1
