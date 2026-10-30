import numpy as np
import pytest
import shapely
from rasterio.transform import Affine
from shapely.geometry import box

from pipeline.infill import HeightLookup, Params, empty_blobs, frontage_plots, infer, open_ground, structures, surface
from pipeline.osm_context import Context

PX = 0.5
SIZE = 120.0
AREA = box(0, 0, SIZE, SIZE)
EMPTY = shapely.Polygon()
CFG = {
    "fill_open_ground": True, "min_blob_m2": 150, "opening_m": 5.0, "building_clearance_m": 1.0, "max_slope_pct": 25,
    "structure_min_height_m": 2.5, "vegetation_roughness": 1.0, "flat_max_height_m": 1.5, "structure_min_m2": 40,
    "structure_opening_m": 1.0, "simplify_m": 0.5, "frontage_depth_m": 12.0, "plot_width_m": 12.0, "party_gap_m": 0.4,
    "min_plot_m2": 30, "neighbour_reach_m": 30, "neighbour_radius_m": 60, "neighbour_min_height_m": 4.0, "min_neighbours": 3, "min_storeys": 3,
    "max_storeys": 7, "floor_height_m": 3.2,
}  # fmt: skip
P = Params(**CFG)


def ctx(street=EMPTY, frontage=None, **over):
    base = {
        "street": street,
        "frontage": street if frontage is None else frontage,
        "rail": EMPTY,
        "water": EMPTY,
        "green": EMPTY,
        "parking": EMPTY,
        "plaza": EMPTY,
    }
    return Context(**{**base, **over})


def grids(structure=None, trees=None, slope_pct=0.0, seed=1):
    """DTM sloping at slope_pct in x, DSM equal to it, plus an optional smooth block and a patch of rough trees."""
    n = int(SIZE / PX)
    transform = Affine(PX, 0, 0, 0, -PX, SIZE)
    x, y = np.meshgrid((np.arange(n) + 0.5) * PX, SIZE - (np.arange(n) + 0.5) * PX)
    dtm = (50 + slope_pct / 100 * x).astype("float32")
    dsm = dtm.copy()
    if structure:
        dsm[(x >= structure[0]) & (x <= structure[2]) & (y >= structure[1]) & (y <= structure[3])] += 8.0
    if trees:
        sel = (x >= trees[0]) & (x <= trees[2]) & (y >= trees[1]) & (y <= trees[3])
        dsm[sel] += (10 + np.random.default_rng(seed).normal(0, 3, sel.sum())).astype("float32")
    return dsm, dtm, transform


# Street along the south edge (y 0 to 8). A mapped building to the west of an empty lot, which spans x 40..100, y 8..40.
STREET = box(0, 0, SIZE, 8)
BUILDING = box(10, 8, 38, 40)
LOT = box(40, 8, 100, 40)


def test_blobs_exclude_streets_buildings_and_unavailable_ground():
    blobs = empty_blobs(AREA, BUILDING, ctx(STREET, green=box(0, 80, SIZE, SIZE)), P)
    union = shapely.unary_union(blobs)
    assert union.intersection(STREET).area == 0
    assert union.intersection(BUILDING.buffer(0.9)).area == 0
    assert union.intersection(box(0, 80, SIZE, SIZE)).area == 0
    assert union.contains(shapely.Point(70, 25))


def test_thin_strips_are_not_blobs():
    verge = box(0, 8, SIZE, 14)  # 6 m wide, narrower than twice the opening
    blobs = empty_blobs(box(0, 0, SIZE, 14), EMPTY, ctx(STREET), P)
    assert shapely.unary_union(blobs).intersection(verge).area == 0 or not blobs


def test_a_smooth_tall_block_is_a_structure_with_its_height_but_trees_and_slopes_are_not():
    dsm, dtm, transform = grids(structure=(50, 60, 80, 90), trees=(10, 60, 40, 90))
    surf = surface(dsm, dtm, transform)
    blobs = empty_blobs(AREA, EMPTY, ctx(STREET), P)
    found = structures(blobs, surf, P)
    assert len(found) == 1
    poly, height = found[0]
    assert poly.contains(shapely.Point(65, 75)) and not poly.contains(shapely.Point(25, 75))
    assert height == pytest.approx(8.0, abs=0.5)
    steep = surface(
        *grids(structure=(50, 60, 80, 90), slope_pct=40),
    )
    assert structures(blobs, steep, P) == []


def test_frontage_plots_sit_beside_the_street_and_clear_of_everything():
    dsm, dtm, transform = grids()
    surf = surface(dsm, dtm, transform)
    blobs = empty_blobs(AREA, BUILDING, ctx(STREET), P)
    ground = open_ground(blobs, surf, P, EMPTY)
    plots = frontage_plots(ground, ctx(STREET), BUILDING, P)
    assert len(plots) >= 3
    union = shapely.unary_union(plots)
    assert union.intersection(STREET).area == 0 and union.intersection(BUILDING).area == 0
    assert all(pl.distance(STREET) <= P.frontage_depth_m for pl in plots)
    assert all(pl.area >= P.min_plot_m2 for pl in plots)
    assert max(pl.bounds[3] for pl in plots) <= 8 + P.frontage_depth_m + 0.1  # one plot deep: the courtyard behind stays empty


def test_a_lone_patch_with_no_mapped_neighbours_is_left_empty():
    dsm, dtm, transform = grids()
    surf = surface(dsm, dtm, transform)
    far = box(10, 100, 20, 110)  # a mapped building more than the reach away from every strip beside the street
    blobs = empty_blobs(AREA, far, ctx(STREET), P)
    plots = frontage_plots(open_ground(blobs, surf, P, EMPTY), ctx(STREET), far, P)
    assert plots == []


def test_height_comes_from_mapped_neighbours_within_the_storey_range():
    near = [box(i, 50, i + 5, 55) for i in range(0, 50, 10)]
    lookup = HeightLookup(near, [15.0] * 5, P)
    assert lookup.at(box(20, 60, 25, 65)) == (15.0, 5)
    assert HeightLookup(near, [50.0] * 5, P).at(box(20, 60, 25, 65))[0] == pytest.approx(7 * 3.2, abs=0.1)  # capped
    assert HeightLookup(near, [2.0] * 5, P).at(box(20, 60, 25, 65))[0] == pytest.approx(3 * 3.2, abs=0.1)  # raised
    far = box(5000, 5000, 5005, 5005)
    h, n = lookup.at(far)
    assert (h, n) == (15.0, 0)  # no neighbours: the area-wide median


def test_infer_returns_both_tiers_with_accounting_and_is_deterministic():
    dsm, dtm, transform = grids(structure=(50, 60, 80, 90))
    surf = surface(dsm, dtm, transform)
    neighbours = [BUILDING, box(10, 44, 38, 58), box(10, 62, 38, 76)]

    def run():
        return infer(AREA, neighbours, neighbours, [14.0, 14.0, 14.0], ctx(STREET), surf, P)

    records, accounting, _ = run()
    basis = {r["basis"] for r in records}
    assert basis == {"lidar", "osm_context"}
    assert all(r["height_m"] > 0 for r in records)
    assert {r["height_m"] for r in records if r["basis"] == "osm_context"} == {14.0}
    assert sum(accounting.values()) > 0 and accounting["structures drawn from LiDAR"] > 0
    assert [(r["basis"], r["geom"].wkb, r["height_m"]) for r in records] == [
        (r["basis"], r["geom"].wkb, r["height_m"]) for r in run()[0]
    ]


def test_turning_off_open_ground_keeps_only_lidar_structures():
    dsm, dtm, transform = grids(structure=(50, 60, 80, 90))
    surf = surface(dsm, dtm, transform)
    off = Params(**{**CFG, "fill_open_ground": False})
    records, _, _ = infer(AREA, [BUILDING], [BUILDING], [14.0], ctx(STREET), surf, off)
    assert {r["basis"] for r in records} == {"lidar"}


def test_inferred_buildings_never_overlap_mapped_ones_or_streets():
    dsm, dtm, transform = grids(structure=(50, 60, 80, 90))
    surf = surface(dsm, dtm, transform)
    records, _, _ = infer(AREA, [BUILDING], [BUILDING], [14.0], ctx(STREET), surf, P)
    union = shapely.unary_union([r["geom"] for r in records])
    assert union.intersection(BUILDING).area == 0 and union.intersection(STREET).area == 0


def test_sheds_and_landmarks_can_be_left_out_of_the_height_basis():
    dsm, dtm, transform = grids()
    surf = surface(dsm, dtm, transform)
    sheds = [box(i, 50, i + 3, 53) for i in range(0, 40, 10)]
    records, _, _ = infer(AREA, [BUILDING, *sheds], [BUILDING], [14.0], ctx(STREET), surf, P)
    plots = [r for r in records if r["basis"] == "osm_context"]
    assert plots and {r["height_m"] for r in plots} == {14.0}  # one ordinary building sets the height, not the sheds


def test_a_footpath_is_not_a_frontage_street():
    dsm, dtm, transform = grids()
    surf = surface(dsm, dtm, transform)
    footpath_only = ctx(STREET, frontage=EMPTY)
    blobs = empty_blobs(AREA, BUILDING, footpath_only, P)
    assert frontage_plots(open_ground(blobs, surf, P, EMPTY), footpath_only, BUILDING, P) == []


def test_a_tile_keeps_only_the_patches_centred_in_its_own_ground():
    """Tiles that split the area together give exactly what one run over the whole area gives, with no patch twice.

    A patch of empty ground goes whole to the tile that holds its centre, so one side may legitimately get nothing.
    """
    dsm, dtm, transform = grids(structure=(50, 60, 80, 90))
    surf = surface(dsm, dtm, transform)
    neighbours = [BUILDING, box(10, 44, 38, 58), box(10, 62, 38, 76)]

    def run(own):
        return infer(AREA, neighbours, neighbours, [14.0] * 3, ctx(STREET), surf, P, own)[0]

    whole = run(None)
    west, east = run(box(0, 0, 60, SIZE)), run(box(60, 0, SIZE, SIZE))
    key = lambda r: (r["basis"], round(r["geom"].centroid.x, 1), round(r["geom"].centroid.y, 1))
    assert sorted(map(key, west + east)) == sorted(map(key, whole))
    assert whole and (len(west) == 0 or len(east) == 0)  # one blob here, so exactly one owner


def test_local_std_matches_a_direct_calculation_and_does_not_depend_on_the_strip_size():
    from pipeline.infill import _local_std

    rng = np.random.default_rng(3)
    a = rng.normal(50, 4, (37, 29)).astype("float32")
    padded = np.pad(a.astype("float64"), 3, mode="edge")
    direct = np.array([[padded[i : i + 7, j : j + 7].std() for j in range(29)] for i in range(37)])
    for strip in (1, 5, 16, 1024):
        assert _local_std(a, 7, strip) == pytest.approx(direct, abs=1e-6)


def test_batched_rasterising_equals_one_mask_per_geometry():
    from pipeline.infill import _mask, _mask_all, _values_in

    dsm, dtm, transform = grids(structure=(50, 60, 80, 90))
    surf = surface(dsm, dtm, transform)
    geoms = [
        box(10, 10, 33.3, 41.7),
        box(30, 30, 70.2, 55.5),
        box(100, 100, 130, 130),
    ]  # overlapping, and one hanging off the grid
    one_by_one = np.zeros(surf.ndsm.shape, bool)
    for g in geoms:
        one_by_one |= _mask(g, surf)
    assert (_mask_all(geoms, surf) == one_by_one).all()
    assert not _mask_all([], surf).any()
    for g in geoms + [box(-20, -20, -5, -5)]:  # the last one lies wholly outside the grid
        assert np.array_equal(_values_in(g, surf.ndsm, surf), surf.ndsm[_mask(g, surf)])


def test_opening_piece_by_piece_equals_opening_the_whole_collection():
    from pipeline.infill import _open

    pieces = [
        box(0, 0, 10, 10),
        box(10.5, 0, 12, 10),
        box(20, 0, 30.5, 8.2),
        shapely.Polygon([(40, 0), (50, 0), (45, 12)]),
        box(60, 0, 61.5, 30),
    ]
    pieces.append(box(70, 0, 80, 10).difference(box(73, 3, 77, 7)))  # with a hole
    whole = shapely.MultiPolygon([p for p in pieces if p.geom_type == "Polygon"])
    expected = whole.buffer(-1.0).buffer(1.0)
    got = _open(whole, 1.0)
    assert got.symmetric_difference(expected).area < 1e-6 * expected.area
    assert _open(shapely.Polygon(), 1.0).is_empty
    assert _open(box(0, 0, 1, 1), 1.0).is_empty  # too thin to survive
