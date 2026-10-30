import pyarrow.parquet as pq
import pytest
import rasterio
import yaml

from pipeline import stage02_heights as s2
from pipeline.common import ROOT, area
from pipeline.footprints import build_footprints, load_osm_tags, read_overture
from pipeline.stage01_footprints import OSM, OVERTURE

pytestmark = pytest.mark.skipif(
    not (OVERTURE.exists() and OSM.exists() and s2.DSM.exists()), reason="raw data not fetched (make fetch)"
)


def footprints():
    model = yaml.safe_load((ROOT / "config" / "model.yaml").read_text())
    return build_footprints(
        read_overture(OVERTURE), load_osm_tags(OSM), area("pilot")["bbox_bng"], model["heights"]["min_footprint_m2"]
    )[0]


def test_footprints_are_identical_between_runs():
    assert footprints().sort_by("id").equals(footprints().sort_by("id"))


def test_heights_are_identical_between_runs():
    model = yaml.safe_load((ROOT / "config" / "model.yaml").read_text())
    table = footprints().sort_by("id").slice(0, 400)
    with rasterio.open(s2.DSM) as d, rasterio.open(s2.DTM) as t:
        dsm, dtm = d.read(1), t.read(1)
        first = s2.compute(table, dsm, dtm, d.transform, model)
        second = s2.compute(table, dsm, dtm, d.transform, model)
    assert first.equals(second)


def test_every_building_has_a_positive_height_and_known_source():
    if not s2.OUT.exists():
        pytest.skip("run make heights first")
    heights = pq.read_table(s2.OUT).to_pylist()
    assert all(h["height_m"] and h["height_m"] > 0 for h in heights)
    assert {h["height_src"] for h in heights} <= {"osm_tag", "lidar", "overture", "floors", "gba", "default", "manual"}
    assert {h["height_conf"] for h in heights} <= {"high", "medium", "low"}
