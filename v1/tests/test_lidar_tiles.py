import pytest

from pipeline.fetch_lidar import tile_names


def test_pilot_window_with_buffer_touches_four_quadrants():
    assert tile_names((324500, 672800, 327100, 675100)) == ["NT27NE", "NT27NW", "NT27SE", "NT27SW"]


def test_pilot_window_without_buffer_needs_two_tiles():
    assert tile_names((324600, 672900, 327000, 675000)) == ["NT27SE", "NT27SW"]


def test_a_box_inside_one_quadrant_needs_one_tile():
    assert tile_names((325200, 673000, 326000, 674000)) == ["NT27SE"]


def test_outside_square_nt_is_rejected():
    with pytest.raises(AssertionError):
        tile_names((100000, 100000, 101000, 101000))


def test_available_keeps_only_source_tiles_that_exist(monkeypatch):
    from pipeline import fetch_lidar

    status = {"https://x/a.tif": 200, "https://x/b.tif": 404, "https://x/c.tif": 200}
    monkeypatch.setattr(fetch_lidar.requests, "head", lambda url, timeout: type("R", (), {"status_code": status[url]})())
    assert fetch_lidar.available(list(status)) == ["https://x/a.tif", "https://x/c.tif"]
