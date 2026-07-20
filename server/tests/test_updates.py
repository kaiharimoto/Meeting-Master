"""Auto-update hub: release picking, asset caching, laptop feed endpoints."""

import asyncio
import copy
import json

import pytest

from app import updates
from app.setup import bootstrap

AUTH = {"Authorization": "Bearer test-token"}


@pytest.fixture(autouse=True)
def _reset_update_info():
    saved = copy.deepcopy(updates._info)
    yield
    updates._info.clear()
    updates._info.update(saved)


# ---- Version parsing / release selection ------------------------------------

def test_parse_version():
    assert updates.parse_version("v0.2.1") == (0, 2, 1)
    assert updates.parse_version("1.10.3") == (1, 10, 3)
    assert updates.parse_version("nope") is None
    assert updates.parse_version("") is None


def test_pick_best_release_excludes_drafts_includes_prereleases():
    releases = [
        {"tag_name": "v0.2.0", "draft": False, "prerelease": True},
        {"tag_name": "v0.3.0", "draft": True, "prerelease": False},  # draft: skip
        {"tag_name": "v0.2.10", "draft": False, "prerelease": True},
        {"tag_name": "junk-tag", "draft": False},  # unparseable: skip
    ]
    best = updates.pick_best_release(releases)
    assert best["tag_name"] == "v0.2.10"  # 0.2.10 > 0.2.9 numerically, not lexically
    assert updates.pick_best_release([]) is None


# ---- Cache resolution -------------------------------------------------------

def test_laptop_dir_picks_newest_cache_with_feed(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETING_MASTER_HOME", str(tmp_path))
    root = tmp_path / "updates"
    (root / "v0.1.0").mkdir(parents=True)
    (root / "v0.1.0" / "latest.yml").write_text("old", encoding="utf-8")
    (root / "v0.3.0").mkdir()
    (root / "v0.3.0" / "latest.yml").write_text("new", encoding="utf-8")
    (root / "v0.9.0").mkdir()  # no latest.yml -> not a valid feed dir

    assert updates.laptop_dir().name == "v0.3.0"
    assert updates.snapshot()["laptopReady"] is True


def test_laptop_dir_none_without_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETING_MASTER_HOME", str(tmp_path))
    assert updates.laptop_dir() is None
    assert updates.snapshot()["laptopReady"] is False


# ---- check_updates ----------------------------------------------------------

def test_check_updates_caches_assets_and_reports(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETING_MASTER_HOME", str(tmp_path))

    release = {
        "tag_name": "v99.0.0",
        "draft": False,
        "prerelease": True,
        "assets": [
            {"name": "latest.yml", "url": "https://api.example/asset/1"},
            {"name": "MeetingMaster-Setup-99.0.0.exe", "url": "https://api.example/asset/2"},
            {"name": "MeetingMaster-HomeServer-Setup.exe", "url": "https://api.example/asset/3"},
            {"name": "unrelated.zip", "url": "https://api.example/asset/4"},
        ],
    }

    async def fake_fetch(settings):
        return [release]

    downloaded = []

    async def fake_download(url, dest, task_name, *, timeout=900.0, headers=None):
        downloaded.append((url, dest.name))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"fake")

    monkeypatch.setattr(updates, "_fetch_releases", fake_fetch)
    monkeypatch.setattr(bootstrap, "_download", fake_download)

    asyncio.run(updates.check_updates())

    names = sorted(name for _, name in downloaded)
    assert names == [
        "MeetingMaster-HomeServer-Setup.exe",
        "MeetingMaster-Setup-99.0.0.exe",
        "latest.yml",
    ]  # unrelated.zip is never fetched
    info = updates.snapshot()
    assert info["tag"] == "v99.0.0"
    assert info["latest"] == "99.0.0"
    assert info["serverReady"] is True  # newer than APP_VERSION + installer cached
    assert info["laptopReady"] is True
    assert bootstrap.task_state(updates.CHECK_TASK)["state"] == "done"


def test_check_updates_up_to_date_still_caches_feed(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETING_MASTER_HOME", str(tmp_path))
    from app.config import APP_VERSION

    release = {
        "tag_name": f"v{APP_VERSION}",
        "draft": False,
        "assets": [{"name": "latest.yml", "url": "https://api.example/a"}],
    }

    async def fake_fetch(settings):
        return [release]

    async def fake_download(url, dest, task_name, *, timeout=900.0, headers=None):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(b"fake")

    monkeypatch.setattr(updates, "_fetch_releases", fake_fetch)
    monkeypatch.setattr(bootstrap, "_download", fake_download)

    asyncio.run(updates.check_updates())

    info = updates.snapshot()
    assert info["serverReady"] is False  # same version -> nothing to install
    assert info["laptopReady"] is True   # but the laptop feed IS cached
    assert "Up to date" in bootstrap.task_state(updates.CHECK_TASK)["message"]


def test_apply_refuses_outside_frozen_build(tmp_path, monkeypatch):
    monkeypatch.setenv("MEETING_MASTER_HOME", str(tmp_path))
    updates._info["tag"] = "v99.0.0"
    dest = updates._tag_dir("v99.0.0")
    dest.mkdir(parents=True)
    (dest / updates.SERVER_ASSET).write_bytes(b"fake")

    asyncio.run(updates.apply_server_update())

    task = bootstrap.task_state(updates.APPLY_TASK)
    assert task["state"] == "failed"
    assert "installed Windows build" in task["message"]


# ---- Laptop feed endpoints --------------------------------------------------

def test_update_feed_requires_bearer(client):
    assert client.get("/updates/laptop/latest.yml").status_code == 401


def test_update_feed_404_without_cache(client, tmp_path, monkeypatch):
    monkeypatch.setenv("MEETING_MASTER_HOME", str(tmp_path))
    resp = client.get("/updates/laptop/latest.yml", headers=AUTH)
    assert resp.status_code == 404


def test_update_feed_serves_cached_assets(client, tmp_path, monkeypatch):
    monkeypatch.setenv("MEETING_MASTER_HOME", str(tmp_path))
    cache = tmp_path / "updates" / "v9.9.9"
    cache.mkdir(parents=True)
    (cache / "latest.yml").write_text("version: 9.9.9\n", encoding="utf-8")
    (cache / "MeetingMaster-Setup-9.9.9.exe").write_bytes(b"MZ fake exe")

    yml = client.get("/updates/laptop/latest.yml", headers=AUTH)
    assert yml.status_code == 200
    assert "9.9.9" in yml.text

    exe = client.get("/updates/laptop/MeetingMaster-Setup-9.9.9.exe", headers=AUTH)
    assert exe.status_code == 200
    assert exe.content == b"MZ fake exe"

    # Whitelist: anything else 404s, including traversal-looking names.
    assert client.get("/updates/laptop/evil.exe", headers=AUTH).status_code == 404
    assert client.get("/updates/laptop/..%2Fserver.env", headers=AUTH).status_code == 404


def test_setup_state_includes_updates(client):
    from fastapi.testclient import TestClient

    from app.main import app

    local = TestClient(app, client=("127.0.0.1", 40000))
    state = local.get("/setup/state").json()
    assert "updates" in state and "current" in state["updates"]
    assert "githubTokenSet" in state
