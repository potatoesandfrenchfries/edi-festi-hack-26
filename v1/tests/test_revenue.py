import copy

import pytest
import yaml

from pipeline.common import ROOT
from pipeline.stage13_revenue import payload, validate

CONFIG = yaml.safe_load((ROOT / "config" / "revenue.yaml").read_text())


def broken(path, value):
    config = copy.deepcopy(CONFIG)
    node = config
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return config


def test_the_shipped_config_is_valid_and_marked_placeholder():
    validate(CONFIG)
    out = payload(CONFIG)
    assert out["status"] == "placeholder"
    assert set(out) == {"status", "fares", "operations", "levy", "parking"}


@pytest.mark.parametrize(
    "path,value",
    [
        (("fares", "average_fare_gbp"), -1),
        (("operations", "bus_operating_gbp_per_km"), "2.5"),
        (("levy", "rate"), 5),  # a percentage, not a share
        (("levy", "paid_share"), 1.2),
        (("levy", "guests_per_room"), 0),
        (("parking", "council_paid_share"), -0.1),
    ],
)
def test_incoherent_values_are_refused(path, value):
    with pytest.raises(ValueError):
        validate(broken(path, value))
