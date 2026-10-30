"""Hourly presence curves and the per-building formula (design section 7, step 2).

    P_b(h, d) = res_pop_b * f_res(h, d) + work_pop_b * f_work(class, h, d) * festival

The web app evaluates the same formula in a MapLibre paint expression. This module is the pipeline-side oracle that the web
tests are checked against. The curves are placeholders (config/profiles.yaml) and the results are modelled estimates.
"""

import yaml

from pipeline.common import ROOT

DAY_TYPES = ["weekday", "saturday", "sunday"]
HOURS = 24


def _trapezoid(t, start, end, ramp):
    """0 outside [start, end + ramp], rising over `ramp` hours from `start`, 1 on the plateau, falling over `ramp` after `end`."""
    up = min(max((t - start) / ramp, 0.0), 1.0)
    down = min(max(1.0 - (t - end) / ramp, 0.0), 1.0)
    return min(up, down)


def hour_curve(shape, day_type):
    """24 values for one (shape, day type). Each hour is evaluated at its mid-point; `end` may exceed 24 to run past midnight."""
    assert shape["ramp"] > 0 and shape["end"] > shape["start"], f"bad curve shape {shape}"
    night, day = shape["night"], shape["day"][day_type]
    values = []
    for hour in range(HOURS):
        t = hour + 0.5
        weight = max(_trapezoid(t + shift, shape["start"], shape["end"], shape["ramp"]) for shift in (-HOURS, 0, HOURS))
        values.append(round(night + (day - night) * weight, 4))
    return values


def expand_profiles(config):
    """Expands the parametric shapes in config/profiles.yaml into 24 values per (class, day type)."""
    day_types = config["day_types"]
    assert day_types == DAY_TYPES
    return {
        "status": config["status"],
        "day_types": day_types,
        "residents": {d: hour_curve(config["residents"], d) for d in day_types},
        "workers": {c: {d: hour_curve(shape, d) for d in day_types} for c, shape in config["workers"].items()},
    }


def load_profiles(path=None):
    return expand_profiles(yaml.safe_load((path or ROOT / "config" / "profiles.yaml").read_text()))


def presence(res_pop, work_pop, use_class, hour, day_type, profiles, festival=1.0):
    """Modelled people present in one building at `hour` on `day_type`. A class with no curve uses the `unknown` curve."""
    workers = profiles["workers"].get(use_class) or profiles["workers"]["unknown"]
    return res_pop * profiles["residents"][day_type][hour] + work_pop * workers[day_type][hour] * festival


def density_per_1000_m2(people, floor_area_m2):
    return people / max(floor_area_m2, 1.0) * 1000.0
