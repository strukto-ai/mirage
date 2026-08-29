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

from mirage.core.gdrive.identity import live_identity
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
