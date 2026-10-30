import json

from pipeline import common


def test_sha256_of_known_content(tmp_path):
    path = tmp_path / "a.txt"
    path.write_bytes(b"abc")
    assert common.sha256(path) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


def test_download_never_refetches_an_existing_file(tmp_path, monkeypatch):
    target = tmp_path / "cached.bin"
    target.write_bytes(b"x")
    monkeypatch.setattr(common.requests, "get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("network used")))
    assert common.download("https://example.test/file", target) == target


def test_record_writes_checksum_and_replaces_entries(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "ROOT", tmp_path)
    monkeypatch.setattr(common, "MANIFEST", tmp_path / "data" / "raw" / "manifest.json")
    data = tmp_path / "data" / "raw" / "f.bin"
    data.parent.mkdir(parents=True)
    data.write_bytes(b"abc")
    entry = common.record("f", data, url="https://example.test/f", licence="OGL")
    assert entry["sha256"].startswith("ba7816bf") and entry["bytes"] == 3
    data.write_bytes(b"abcd")
    common.record("f", data, url="https://example.test/f", licence="OGL")
    manifest = json.loads(common.MANIFEST.read_text())
    assert list(manifest) == ["f"] and manifest["f"]["bytes"] == 4
