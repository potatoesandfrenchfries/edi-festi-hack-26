import copy

import pytest
import yaml

from pipeline.common import ROOT
from pipeline.stage12_transport import payload, validate

CONFIG = yaml.safe_load((ROOT / "config" / "transport.yaml").read_text())


def broken(path, value):
    config = copy.deepcopy(CONFIG)
    node = config
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return config


def test_the_shipped_config_is_valid_and_marked_placeholder():
    validate(CONFIG)
    assert payload(CONFIG)["status"] == "placeholder"


@pytest.mark.parametrize(
    "path,value",
    [
        (("modes", "car_share", "stay"), 1.2),
        (("modes", "car_share", "local"), 0.8),  # car 0.8 + bus 0.3 > 1
        (("modes", "spill_to_car"), -0.1),
        (("bus", "seats_per_bus"), 0),
        (("simulation", "trip_window_end_hour"), 10),
        (("levers", "park_and_ride", "default"), 0.9),
        (("levers", "park_and_ride", "extra_minutes"), -5),
        (("bus", "turned_away_hours"), 0),
    ],
)
def test_incoherent_values_are_refused(path, value):
    with pytest.raises(ValueError):
        validate(broken(path, value))
