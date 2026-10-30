"""Stage 12: the festival-travel assumptions for the web app.

    uv run python -m pipeline.stage12_transport

Reads config/transport.yaml, checks it, and writes web/public/data/transport.json for web/src/trip-demand.ts and scenario.ts. The values
are placeholders until calibrated, and the file says so (`status`).
"""

import json

import yaml

from pipeline.common import ROOT

OUT = ROOT / "web" / "public" / "data" / "transport.json"
CLASSES = ("local", "daytrip", "stay")


def validate(config):
    """Raise ValueError unless the shares are in 0..1 (car and bus together at most 1), the other numbers are positive and the lever range is coherent."""
    modes = config["modes"]
    for cls in CLASSES:
        car, bus = modes["car_share"][cls], modes["bus_share"][cls]
        if not (0 <= car <= 1 and 0 <= bus <= 1 and car + bus <= 1):
            raise ValueError(f"modes: {cls} car {car} and bus {bus} must each be in 0..1 and sum to at most 1")
    if not 0 <= modes["spill_to_car"] <= 1:
        raise ValueError("modes.spill_to_car must be in 0..1")
    for section, keys in (("modes", ("car_occupancy",)), ("bus", ("seats_per_bus", "load_factor", "festival_routes_share", "fallback_departures_per_hour")),
                           ("simulation", ("sim_scale",)), ("walking", ("speed_m_s",))):  # fmt: skip
        for key in keys:
            if not config[section][key] > 0:
                raise ValueError(f"{section}.{key} must be positive")
    sim = config["simulation"]
    if not 0 <= sim["trip_window_start_hour"] < sim["trip_window_end_hour"] <= 24:
        raise ValueError("simulation: the trip window needs 0 <= start < end <= 24")
    lever = config["levers"]["park_and_ride"]
    if not (0 <= lever["min"] <= lever["default"] <= lever["max"] <= 1 and lever["step"] > 0):
        raise ValueError("levers.park_and_ride needs 0 <= min <= default <= max <= 1 and a positive step")


def payload(config):
    validate(config)
    return {key: config[key] for key in ("status", "modes", "bus", "simulation", "walking", "levers")}


def main():
    config = yaml.safe_load((ROOT / "config" / "transport.yaml").read_text())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload(config), separators=(",", ":")))
    print(f"wrote {OUT} (status: {config['status']})")


if __name__ == "__main__":
    main()
