"""Stage 09: the congestion-impact constants for the web app.

    uv run python -m pipeline.stage09_economics

Reads config/economics.yaml, checks it, and writes web/public/data/economics.json for web/src/impact.ts. The values are placeholders
until calibrated, and the file says so (`status`).
"""

import json

import yaml

from pipeline.common import ROOT

OUT = ROOT / "web" / "public" / "data" / "economics.json"
SECTIONS = ("time", "fuel", "emissions", "scale")
RANGES = ("car_demand", "bus_frequency")


def validate(config):
    """Raise ValueError unless every number is positive, the hourly profile has 24 values in 0..1 and each slider range is coherent."""
    for section in SECTIONS:
        for key, value in config[section].items():
            if not isinstance(value, (int, float)) or value <= 0:
                raise ValueError(f"{section}.{key} must be a positive number, got {value!r}")
    demand = config["demand"]
    profile = demand["car_hourly_profile"]
    if len(profile) != 24 or not all(0 <= v <= 1 for v in profile):
        raise ValueError("demand.car_hourly_profile needs 24 values between 0 and 1")
    for name in RANGES:
        r = demand[name]
        if not (0 < r["min"] <= r["default"] <= r["max"] and r["step"] > 0):
            raise ValueError(f"demand.{name} needs 0 < min <= default <= max and a positive step")


def payload(config):
    validate(config)
    return {"status": config["status"], **{s: config[s] for s in SECTIONS}, "demand": config["demand"]}


def main():
    config = yaml.safe_load((ROOT / "config" / "economics.yaml").read_text())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload(config), separators=(",", ":")))
    print(f"wrote {OUT} (status: {config['status']})")


if __name__ == "__main__":
    main()
