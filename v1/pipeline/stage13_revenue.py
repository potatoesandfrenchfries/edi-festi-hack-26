"""Stage 13: the festival revenue assumptions for the web app.

    uv run python -m pipeline.stage13_revenue

Reads config/revenue.yaml, checks it, and writes web/public/data/revenue.json for web/src/revenue.ts and scenario.ts. The values are
placeholders until calibrated, and the file says so (`status`).
"""

import json

import yaml

from pipeline.common import ROOT

OUT = ROOT / "web" / "public" / "data" / "revenue.json"
SECTIONS = ("fares", "operations", "levy", "parking")
SHARES = (("levy", "rate"), ("levy", "paid_share"), ("levy", "levied_night_share"), ("parking", "council_paid_share"))
POSITIVE = (("levy", "guests_per_room"),)


def validate(config):
    """Raise ValueError unless every money value is not negative, the shares are in 0..1 and the guests per room are positive."""
    for section in SECTIONS:
        for key, value in config[section].items():
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
                raise ValueError(f"{section}.{key} must be a number of at least 0, got {value!r}")
    for section, key in SHARES:
        if not 0 <= config[section][key] <= 1:
            raise ValueError(f"{section}.{key} must be in 0..1")
    for section, key in POSITIVE:
        if not config[section][key] > 0:
            raise ValueError(f"{section}.{key} must be positive")


def payload(config):
    validate(config)
    return {"status": config["status"], **{s: config[s] for s in SECTIONS}}


def main():
    config = yaml.safe_load((ROOT / "config" / "revenue.yaml").read_text())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload(config), separators=(",", ":")))
    print(f"wrote {OUT} (status: {config['status']})")


if __name__ == "__main__":
    main()
