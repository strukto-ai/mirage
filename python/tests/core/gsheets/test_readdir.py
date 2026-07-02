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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gsheets.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GSheetsAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(
        accessor,
        PathSpec(resource_path=mount_key("/gsheets", "/gsheets"),
                 virtual="/gsheets",
                 directory="/gsheets"), index)
    assert result == ["/gsheets/owned", "/gsheets/shared"]


@pytest.mark.asyncio
async def test_readdir_owned(accessor, index):
    files = [
        {
            "id": "sheet1",
            "name": "Budget",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{
                "me": True
            }],
        },
    ]
    with patch(
            "mirage.core.gsheets.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned", "/gsheets"),
                     virtual="/gsheets/owned",
                     directory="/gsheets/owned"), index)
        assert len(result) == 1
        assert "sheet1" in result[0]


@pytest.mark.asyncio
async def test_readdir_file_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned/file.gsheet.json",
                                             "/gsheets"),
                     virtual="/gsheets/owned/file.gsheet.json",
                     directory="/gsheets/owned/file.gsheet.json"), index)


@pytest.mark.asyncio
async def test_readdir_invalid_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/bogus", "/gsheets"),
                     virtual="/gsheets/bogus",
                     directory="/gsheets/bogus"), index)


@pytest.mark.asyncio
async def test_readdir_owned_pushes_modified_range(accessor, index):
    captured = {}

    async def fake_list(token_manager, mime_type=None, **kwargs):
        captured.update(kwargs)
        captured["mime_type"] = mime_type
        return []

    with patch("mirage.core.gsheets.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned/2026-05-*",
                                             "/gsheets"),
                     virtual="/gsheets/owned/2026-05-*",
                     directory="/gsheets/owned",
                     pattern="2026-05-*"), index)

    assert captured["modified_after"] == "2026-05-01T00:00:00Z"
    assert captured["modified_before"] == "2026-06-01T00:00:00Z"


@pytest.mark.asyncio
async def test_readdir_owned_filtered_does_not_cache(accessor, index):
    files = [{
        "id": "may",
        "name": "MaySheet",
        "modifiedTime": "2026-05-15T00:00:00.000Z",
        "owners": [{
            "me": True
        }]
    }]
    full_files = files + [{
        "id": "jan",
        "name": "JanSheet",
        "modifiedTime": "2026-01-15T00:00:00.000Z",
        "owners": [{
            "me": True
        }]
    }]

    call_count = {"n": 0}

    async def fake_list(token_manager,
                        mime_type=None,
                        modified_after=None,
                        modified_before=None,
                        **kwargs):
        call_count["n"] += 1
        if modified_after:
            return files
        return full_files

    with patch("mirage.core.gsheets.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned/2026-05-*",
                                             "/gsheets"),
                     virtual="/gsheets/owned/2026-05-*",
                     directory="/gsheets/owned",
                     pattern="2026-05-*"), index)
        result = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned", "/gsheets"),
                     virtual="/gsheets/owned",
                     directory="/gsheets/owned"), index)

    assert call_count["n"] == 2
    assert len(result) == 2


@pytest.mark.asyncio
async def test_readdir_owned_filtered_bypasses_warm_cache(accessor, index):
    full_files = [
        {
            "id": "may",
            "name": "MaySheet",
            "modifiedTime": "2026-05-15T00:00:00.000Z",
            "owners": [{
                "me": True
            }]
        },
        {
            "id": "jan",
            "name": "JanSheet",
            "modifiedTime": "2026-01-15T00:00:00.000Z",
            "owners": [{
                "me": True
            }]
        },
    ]
    may_only = [full_files[0]]

    call_count = {"n": 0}

    async def fake_list(token_manager,
                        mime_type=None,
                        modified_after=None,
                        modified_before=None,
                        **kwargs):
        call_count["n"] += 1
        if modified_after:
            return may_only
        return full_files

    with patch("mirage.core.gsheets.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned", "/gsheets"),
                     virtual="/gsheets/owned",
                     directory="/gsheets/owned"), index)
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned/2026-05-*",
                                             "/gsheets"),
                     virtual="/gsheets/owned/2026-05-*",
                     directory="/gsheets/owned",
                     pattern="2026-05-*"), index)

    assert call_count["n"] == 2


@pytest.mark.asyncio
async def test_readdir_owned_no_pattern_omits_range(accessor, index):
    captured = {}

    async def fake_list(token_manager, mime_type=None, **kwargs):
        captured.update(kwargs)
        return []

    with patch("mirage.core.gsheets.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned", "/gsheets"),
                     virtual="/gsheets/owned",
                     directory="/gsheets/owned"), index)

    assert captured.get("modified_after") is None
    assert captured.get("modified_before") is None


@pytest.mark.asyncio
async def test_readdir_owned_non_date_pattern_omits_range(accessor, index):
    captured = {}

    async def fake_list(token_manager, mime_type=None, **kwargs):
        captured.update(kwargs)
        return []

    with patch("mirage.core.gsheets.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gsheets/owned/*foo*",
                                             "/gsheets"),
                     virtual="/gsheets/owned/*foo*",
                     directory="/gsheets/owned",
                     pattern="*foo*"), index)

    assert captured.get("modified_after") is None
    assert captured.get("modified_before") is None
