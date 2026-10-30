import pytest
import shapely

from pipeline.stage06_tiles import inferred_feature, part_feature, serves, to_feature


def record(**over):
    base = {
        "id": "abc",
        "geom_wkb": shapely.to_wkb(shapely.box(325000, 673500, 325020, 673520)),  # near the Castle, in EPSG:27700
        "height_m": 12.345,
        "height_src": "lidar",
        "height_conf": "high",
        "height_flag": None,
        "floors_est": 3.858,
        "osm_name": None,
        "use_class": "office",
        "use_src": None,
        "res_pop": 0.0,
        "work_pop": 12.3456,
        "floor_area_m2": 1543.6,
    }
    return {**base, **over}


def test_feature_is_in_wgs84_and_rounds_properties():
    feature = to_feature(record())
    lon, lat = feature["geometry"]["coordinates"][0][0]
    assert -3.3 < lon < -3.1 and 55.9 < lat < 56.0
    assert feature["properties"] == {
        "id": "abc",
        "height_m": 12.3,
        "height_src": "lidar",
        "height_conf": "high",
        "floors_est": 3.9,
        "use_class": "office",
        "res_pop": 0.0,
        "work_pop": 12.35,
        "floor_area_m2": 1544,
    }


def test_optional_properties_appear_only_when_set():
    props = to_feature(record(height_flag="steep_terrain", osm_name="The Hub", use_src="osm"))["properties"]
    assert props["height_flag"] == "steep_terrain" and props["name"] == "The Hub" and props["use_src"] == "osm"


def test_no_cost_like_properties_are_ever_emitted():
    props = to_feature(record(height_flag="steep_terrain", osm_name="x"))["properties"]
    assert not [k for k in props if any(word in k for word in ("cost", "price", "rent", "rateable", "value"))]


def test_part_feature_carries_parent_and_rounded_height():
    rec = {"id": "abc#0", "parent_id": "abc", "level": 1, "height_m": 73.96, "geom_wkb": record()["geom_wkb"]}
    feature = part_feature(rec, {"abc": record()})
    assert feature["properties"] == {
        "id": "abc#0", "parent_id": "abc", "height_m": 74.0,
        "use_class": "office", "res_pop": 0.0, "work_pop": 12.35, "floor_area_m2": 1544,
    }  # fmt: skip
    assert -3.3 < feature["geometry"]["coordinates"][0][0][0] < -3.1


def test_inferred_feature_says_how_it_was_inferred():
    rec = {"id": "inf-1-2", "basis": "osm_context", "height_m": 14.04, "geom_wkb": record()["geom_wkb"]}
    feature = inferred_feature(rec)
    assert feature["properties"] == {"id": "inf-1-2", "basis": "osm_context", "height_m": 14.0}
    assert -3.3 < feature["geometry"]["coordinates"][0][0][0] < -3.1


def table_of(*rows):
    import pyarrow as pa

    return pa.Table.from_pylist([record(**row) for row in rows])


def test_oracle_cases_use_the_tile_rounded_values_and_the_shared_formula():
    from pipeline.presence import load_profiles, presence
    from pipeline.stage06_tiles import ORACLE_CASES, oracle_cases

    profiles = load_profiles()
    table = table_of(
        {"id": "a", "use_class": "office", "res_pop": 0.0, "work_pop": 12.3456},
        {"id": "b", "use_class": "residential", "res_pop": 7.777, "work_pop": 0.4},
        {"id": "c", "use_class": "unknown", "res_pop": 0.0, "work_pop": 0.0},  # nobody lives or works here, so it is not sampled
    )
    cases = oracle_cases(table, profiles)
    assert [c["id"] for c in cases] == ["a", "b"]
    assert cases[0]["work_pop"] == 12.35 and cases[1]["res_pop"] == 7.78  # as written to the tiles
    assert len(cases[0]["expected"]) == len(ORACLE_CASES)
    first = cases[0]["expected"][1]
    assert first["people"] == pytest.approx(
        presence(0.0, 12.35, "office", first["hour"], first["day"], profiles, first["festival"]), abs=1e-5
    )


def test_profiles_payload_has_what_the_web_app_reads():
    from pipeline.presence import load_profiles
    from pipeline.stage06_tiles import profiles_payload

    table = table_of(
        {"id": "a", "use_class": "office", "res_pop": 0.0, "work_pop": 10.0},
        {"id": "b", "use_class": "office", "res_pop": 1.0, "work_pop": 5.0},
        {"id": "c", "use_class": "residential", "res_pop": 20.0, "work_pop": 1.0},
    )
    payload = profiles_payload(load_profiles(), table)
    assert payload["totals"] == {"buildings": 3, "residents": 21.0, "workers": {"office": 15.0, "residential": 1.0}}
    assert payload["status"] == "placeholder" and payload["values"] == "template"
    assert set(payload["festival"]) == {"min", "max", "step", "default"}
    assert payload["festival"]["min"] <= payload["festival"]["default"] <= payload["festival"]["max"]
    assert len(payload["scale"]["density_breaks"]) == len(payload["scale"]["total_breaks"]) == 5
    assert payload["scale"]["density_breaks"] == sorted(payload["scale"]["density_breaks"])


def test_a_pilot_build_does_not_replace_the_full_city_the_web_app_shows():
    assert not serves("pilot", "full")
    assert serves("pilot", "full", force=True)


def test_a_full_build_always_replaces_and_a_first_build_always_copies():
    assert serves("full", "pilot") and serves("full", "full") and serves("full", None)
    assert serves("pilot", None) and serves("pilot", "pilot")
