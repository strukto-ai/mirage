# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio

import pytest

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.core.gridfs import driver as gridfs_driver
from mirage.core.gridfs.identity import live_identity
from mirage.types import PathSpec


def _accessor() -> GridFSAccessor:
    return GridFSAccessor(
        GridFSConfig(uri="mongodb://localhost:27017", database="db"))


def _path(mount_path: str) -> PathSpec:
    key = mount_path.strip("/")
    return PathSpec(virtual="/mnt" + mount_path if key else "/mnt",
                    directory="/mnt/",
                    resource_path=key)


class _FakeFilesColl:
    """Stands in for the fs.files collection ``_probe_prefix`` queries."""

    def __init__(self, hit: bool) -> None:
        self.hit = hit
        self.queries: list[dict] = []

    async def find_one(self, query, projection=None, sort=None):
        self.queries.append(query)
        return {"_id": "marker"} if self.hit else None


def test_identity_found_file_returns_the_gridfs_id_as_both_markers(
        monkeypatch):

    async def fake_latest_file(conn, key):
        return {"filename": "a.txt", "_id": "abc123", "length": 5}

    monkeypatch.setattr(gridfs_driver, "latest_file", fake_latest_file)
    result = asyncio.run(live_identity(_accessor(), _path("/a.txt")))
    assert result.exists is True
    assert result.revision == "abc123"
    assert result.fingerprint == "abc123"


def test_identity_head_miss_probe_hit_is_a_directory(monkeypatch):

    async def fake_latest_file(conn, key):
        return None

    monkeypatch.setattr(gridfs_driver, "latest_file", fake_latest_file)
    monkeypatch.setattr(gridfs_driver, "files_coll",
                        lambda conn: _FakeFilesColl(hit=True))
    with pytest.raises(IsADirectoryError):
        asyncio.run(live_identity(_accessor(), _path("/dir")))


def test_identity_head_miss_probe_miss_is_absent(monkeypatch):

    async def fake_latest_file(conn, key):
        return None

    monkeypatch.setattr(gridfs_driver, "latest_file", fake_latest_file)
    monkeypatch.setattr(gridfs_driver, "files_coll",
                        lambda conn: _FakeFilesColl(hit=False))
    result = asyncio.run(live_identity(_accessor(), _path("/never.txt")))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


def test_identity_mount_root_is_a_directory_without_a_lookup(monkeypatch):

    async def unexpected_latest_file(conn, key):
        raise AssertionError("mount root must not reach the store")

    monkeypatch.setattr(gridfs_driver, "latest_file", unexpected_latest_file)
    with pytest.raises(IsADirectoryError):
        asyncio.run(live_identity(_accessor(), _path("/")))
