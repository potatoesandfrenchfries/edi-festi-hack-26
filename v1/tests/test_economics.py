import copy

import pytest
import yaml

from pipeline.common import ROOT
from pipeline.stage09_economics import payload, validate


@pytest.fixture
def config():
    return yaml.safe_load((ROOT / "config" / "economics.yaml").read_text())


def test_shipped_config_is_valid_and_marked_placeholder(config):
    out = payload(config)
    assert out["status"] == "placeholder"
    assert set(out) == {"status", "time", "fuel", "emissions", "scale", "demand"}


def test_hourly_profile_has_24_hours_peaking_at_one(config):
    profile = config["demand"]["car_hourly_profile"]
    assert len(profile) == 24 and max(profile) == 1.0


def test_negative_constant_is_rejected(config):
    bad = copy.deepcopy(config)
    bad["fuel"]["car_litres_per_km"] = -1
    with pytest.raises(ValueError, match="car_litres_per_km"):
        validate(bad)


def test_short_profile_is_rejected(config):
    bad = copy.deepcopy(config)
    bad["demand"]["car_hourly_profile"] = [0.5] * 23
    with pytest.raises(ValueError, match="24 values"):
        validate(bad)


def test_default_outside_slider_range_is_rejected(config):
    bad = copy.deepcopy(config)
    bad["demand"]["bus_frequency"]["default"] = 9
    with pytest.raises(ValueError, match="bus_frequency"):
        validate(bad)
