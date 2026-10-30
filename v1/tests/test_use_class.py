import pytest
import yaml

from pipeline.common import ROOT
from pipeline.template_values import template_values
from pipeline.use_class import classify

MODEL = yaml.safe_load((ROOT / "config" / "model.yaml").read_text())
WEIGHTS = yaml.safe_load((ROOT / "config" / "use_weights.yaml").read_text())


@pytest.mark.parametrize(
    ("tags", "expected"),
    [
        ({"osm_building": "apartments"}, ("residential", "osm")),
        ({"osm_building": "yes", "osm_shop": "clothes"}, ("retail", "osm")),
        ({"osm_building": "yes", "osm_amenity": "pub"}, ("hospitality", "osm")),
        ({"osm_building": "apartments", "osm_amenity": "student_accommodation"}, ("residential", "osm")),
        ({"osm_building": "yes", "osm_tourism": "hotel"}, ("hospitality", "osm")),
        ({"osm_building": "yes", "osm_office": "company"}, ("office", "osm")),
        ({"osm_building": "yes", "overture_class": "university"}, ("education", "overture")),
        ({"osm_building": "yes", "overture_subtype": "religious"}, ("civic", "overture")),
        ({"osm_building": "church", "overture_class": "house"}, ("civic", "osm")),
        ({"osm_building": "yes"}, ("unknown", None)),
        ({}, ("unknown", None)),
    ],
)
def test_classify(tags, expected):
    assert classify(**tags) == expected


def test_specific_tags_beat_the_generic_building_word():
    assert classify(osm_building="house", osm_shop="books") == ("retail", "osm")


def test_residential_gets_residents_and_few_workers():
    res, work = template_values("residential", 1000.0, MODEL, WEIGHTS)
    assert res == pytest.approx(1000 * MODEL["template_values"]["residents_per_m2"])
    assert 0 < work < res


def test_non_residential_has_no_residents():
    res, work = template_values("office", 1000.0, MODEL, WEIGHTS)
    assert res == 0.0 and work == pytest.approx(1000 * MODEL["template_values"]["workers_per_m2"] * WEIGHTS["office"])


def test_mixed_and_unknown_split_floor_area():
    share = MODEL["mixed_use_residential_share"]
    for use_class in ("mixed", "unknown"):
        res, work = template_values(use_class, 1000.0, MODEL, WEIGHTS)
        assert res == pytest.approx(1000 * share * MODEL["template_values"]["residents_per_m2"])
        assert work == pytest.approx(1000 * (1 - share) * MODEL["template_values"]["workers_per_m2"] * WEIGHTS[use_class])


def test_values_scale_with_floor_area_and_are_never_negative():
    for use_class in WEIGHTS:
        small, large = template_values(use_class, 100.0, MODEL, WEIGHTS), template_values(use_class, 200.0, MODEL, WEIGHTS)
        assert all(a >= 0 for a in small) and large == pytest.approx(tuple(2 * a for a in small))
