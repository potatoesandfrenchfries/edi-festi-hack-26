import importlib

import pytest

STAGES = ["stage03_use_class", "stage04_census", "stage05_allocate", "stage07_calibrate"]


@pytest.mark.parametrize("name", STAGES)
def test_unwritten_stages_fail_clearly(name):
    module = importlib.import_module(f"pipeline.{name}")
    with pytest.raises(SystemExit, match="not implemented yet"):
        module.main()
