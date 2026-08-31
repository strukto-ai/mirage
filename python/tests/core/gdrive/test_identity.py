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

from unittest.mock import AsyncMock, patch

import pytest

import mirage.core.gdrive.read as read_mod
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdrive.identity import live_identity
from mirage.core.gdrive.read import read
from mirage.core.gdrive.resolve import resolve_key
from mirage.types import PathSpec


def _path(key: str) -> PathSpec:
    return PathSpec(virtual="/" + key, directory="/", resource_path=key)


@pytest.mark.asyncio
async def test_identity_found_file_returns_markers(fake_drive,
                                                   gdrive_accessor):
    fake_drive.add("a.txt", content=b"hi")
    with patch(
            "mirage.core.gdrive.versions.google_get",
            new_callable=AsyncMock,
            return_value={
                "headRevisionId": "r9",
                "md5Checksum": "abc"
            },
    ):
        result = await live_identity(gdrive_accessor, _path("a.txt"))
    assert result.exists is True
    assert result.revision == "r9"
    assert result.fingerprint == "abc"


@pytest.mark.asyncio
async def test_identity_missing_reports_exists_false(fake_drive,
                                                     gdrive_accessor):
    fake_drive.folder("a")
    result = await live_identity(gdrive_accessor, _path("a/missing.txt"))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


@pytest.mark.asyncio
async def test_identity_folder_raises_eisdir(fake_drive, gdrive_accessor):
    fake_drive.folder("dir")
    with pytest.raises(IsADirectoryError):
        await live_identity(gdrive_accessor, _path("dir"))


@pytest.mark.asyncio
async def test_identity_mount_root_raises_eisdir_without_resolving(
        fake_drive, gdrive_accessor):
    with pytest.raises(IsADirectoryError):
        await live_identity(gdrive_accessor, _path(""))


@pytest.mark.asyncio
async def test_identity_folder_spelled_with_a_trailing_slash_is_eisdir(
        fake_drive, gdrive_accessor):
    # Drive is id-addressed and the key the resolver walks carries no
    # trailing slash, so the hint costs nothing: the folder resolves and
    # the file-only contract refuses it, the same as without the slash.
    fake_drive.folder("dir")
    with pytest.raises(IsADirectoryError):
        await live_identity(
            gdrive_accessor,
            PathSpec(virtual="/dir/", directory="/", resource_path="dir"))


@pytest.mark.asyncio
async def test_identity_absent_path_with_a_trailing_slash_reports_absent(
        fake_drive, gdrive_accessor):
    fake_drive.folder("a")
    result = await live_identity(
        gdrive_accessor,
        PathSpec(virtual="/a/gone/", directory="/a", resource_path="a/gone"))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


@pytest.mark.parametrize("newest_first", [False, True])
@pytest.mark.asyncio
async def test_identity_and_a_warmed_read_name_the_same_duplicate(
        fake_drive, gdrive_accessor, monkeypatch, newest_first):
    # Drive allows duplicate sibling names, and the two halves of a
    # read-check-write reach the file by different routes: identity
    # resolves the name with a direct query, the read resolves it
    # through the index the listing warmed. Disagreeing made every such
    # caller see a conflict with no writer.
    times = ["2026-06-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    if not newest_first:
        times.reverse()
    ids = [
        fake_drive.add("dup.txt", content=f"body-{i}".encode(), modified=stamp)
        for i, stamp in enumerate(times)
    ]
    newest = ids[times.index("2026-06-01T00:00:00Z")]

    async def download(token_manager, file_id, window=None):
        return await fake_drive.download_file(token_manager, file_id)

    monkeypatch.setattr(read_mod, "download_file", download)
    path = PathSpec(virtual="/dup.txt", directory="/", resource_path="dup.txt")

    node = await resolve_key(gdrive_accessor, "dup.txt")
    assert node is not None and node.id == newest

    store = RAMIndexCacheStore()
    data = await read(gdrive_accessor, path, index=store)
    assert data == fake_drive.items[newest]["content"]
    assert (await store.get("/dup.txt")).entry.id == newest

    with patch(
            "mirage.core.gdrive.versions.google_get",
            new_callable=AsyncMock,
            return_value={
                "headRevisionId": "r1",
                "md5Checksum": "abc"
            },
    ) as metadata:
        result = await live_identity(gdrive_accessor, path)
    assert result.exists is True
    # The identity was captured for the file the read delivered, not
    # for its same-named sibling.
    assert newest in metadata.call_args.args[1]
