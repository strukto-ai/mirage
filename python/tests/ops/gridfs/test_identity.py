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

from mirage.accessor.gridfs import GridFSAccessor, GridFSConfig
from mirage.core.gridfs import driver as gridfs_driver
from mirage.ops.gridfs.identity import live_identity
from mirage.types import PathSpec


class _PoisonIndex:
    """An index cache that fails loudly if the op ever consults it."""

    def __getattr__(self, name):
        raise AssertionError(f"live_identity must not touch index.{name}")


def _accessor() -> GridFSAccessor:
    return GridFSAccessor(
        GridFSConfig(uri="mongodb://localhost:27017", database="db"))


def _path(mount_path: str) -> PathSpec:
    key = mount_path.strip("/")
    return PathSpec(virtual="/mnt" + mount_path if key else "/mnt",
                    directory="/mnt/",
                    resource_path=key)


def test_live_identity_ignores_a_poisoned_index(monkeypatch):

    async def fake_latest_file(conn, key):
        return {"filename": "a.txt", "_id": "abc123", "length": 5}

    monkeypatch.setattr(gridfs_driver, "latest_file", fake_latest_file)
    result = asyncio.run(
        live_identity(_accessor(), _path("/a.txt"), index=_PoisonIndex()))
    assert result.exists is True
    assert result.revision == "abc123"
    assert result.fingerprint == "abc123"
