import json
import re

import pytest
import yaml
from pyproj import Transformer

from pipeline.common import ROOT

CONFIG = ROOT / "config"
ORIGIN = re.compile(r"#\s*(placeholder|literature|calibrated|assumption)\b")
USE_CLASSES = {"residential", "retail", "office", "hospitality", "education", "civic", "industrial", "mixed", "unknown"}
FORBIDDEN = re.compile(r"\b(cost|price|rent|rateable|rateable_value|economic)\b", re.IGNORECASE)
PROPERTY_FORBIDDEN = re.compile(r"\b(rent|rateable|rateable_value|property_price)\b", re.IGNORECASE)
TRAFFIC_IMPACT = {"economics.yaml"}  # design rule 6 exception: modelled road-congestion impact, labelled as an estimate


@pytest.mark.parametrize("name", ["model.yaml", "use_weights.yaml", "profiles.yaml", "roads.yaml", "economics.yaml", "demand.yaml", "accommodation.yaml", "transport.yaml"])
def test_every_value_states_its_origin(name):
    """Design rule 8: every tunable has a comment saying whether it is a placeholder, literature, calibrated or an assumption."""
    for number, line in enumerate((CONFIG / name).read_text().splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        value = stripped.partition(":")[2]
        has_value = value.split("#")[0].strip() != ""
        if has_value:
            assert ORIGIN.search(line), f"{name}:{number} has a value but no origin comment: {line!r}"


def test_use_weights_cover_exactly_the_use_classes():
    weights = yaml.safe_load((CONFIG / "use_weights.yaml").read_text())
    assert set(weights) == USE_CLASSES
    assert all(isinstance(v, (int, float)) and v >= 0 for v in weights.values())


def test_profiles_are_marked_as_placeholder_until_calibrated():
    profiles = yaml.safe_load((CONFIG / "profiles.yaml").read_text())
    assert profiles["status"] == "placeholder"
    assert profiles["day_types"] == ["weekday", "saturday", "sunday"]


def test_model_sensitivity_bounds_bracket_the_defaults():
    model = yaml.safe_load((CONFIG / "model.yaml").read_text())
    low, high = model["sensitivity"]["floor_height_m"]
    assert low < model["floor_height_m"] < high
    assert model["sensitivity"]["use_weight_scale"][0] < 1 < model["sensitivity"]["use_weight_scale"][1]


def test_wgs84_bbox_matches_the_bng_bbox():
    pilot = json.loads((CONFIG / "area.json").read_text())["pilot"]
    to_wgs84 = Transformer.from_crs(27700, 4326, always_xy=True)
    west, south = to_wgs84.transform(pilot["bbox_bng"][0], pilot["bbox_bng"][1])
    east, north = to_wgs84.transform(pilot["bbox_bng"][2], pilot["bbox_bng"][3])
    assert pilot["bbox_wgs84"] == pytest.approx([west, south, east, north], abs=2e-5)


def test_no_cost_fields_in_config():
    """Design rule 6: no cost, price, rent or rateable-value fields in the building config. The traffic-impact file is exempt from
    the cost and price words only; it still may not carry rent or rateable-value keys."""
    for path in CONFIG.iterdir():
        keys = re.findall(r"^\s*\"?([A-Za-z_]+)\"?\s*:", path.read_text(), re.MULTILINE)
        rule = PROPERTY_FORBIDDEN if path.name in TRAFFIC_IMPACT else FORBIDDEN
        assert not [k for k in keys if rule.search(k)], f"{path.name} has a cost-like key"
