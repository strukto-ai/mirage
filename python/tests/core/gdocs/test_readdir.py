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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdocs.readdir import readdir
from mirage.core.gdocs.stat import stat
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GDocsAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(
        accessor,
        PathSpec(resource_path=mount_key("/gdocs", "/gdocs"),
                 virtual="/gdocs",
                 directory="/gdocs"), index)
    assert result == ["/gdocs/owned", "/gdocs/shared"]


@pytest.mark.asyncio
async def test_readdir_owned(accessor, index):
    files = [
        {
            "id": "doc1",
            "name": "My Doc",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{
                "me": True
            }],
        },
    ]
    with patch(
            "mirage.core.gdocs.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                     virtual="/gdocs/owned",
                     directory="/gdocs/owned"), index)
        assert len(result) == 1
        assert "doc1" in result[0]


@pytest.mark.asyncio
async def test_readdir_shared(accessor, index):
    files = [
        {
            "id": "doc2",
            "name": "Shared Doc",
            "modifiedTime": "2026-03-15T00:00:00.000Z",
            "owners": [{
                "me": False
            }],
        },
    ]
    with patch(
            "mirage.core.gdocs.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/shared", "/gdocs"),
                     virtual="/gdocs/shared",
                     directory="/gdocs/shared"), index)
        assert len(result) == 1
        assert "doc2" in result[0]


@pytest.mark.asyncio
async def test_readdir_file_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned/file.gdoc.json",
                                             "/gdocs"),
                     virtual="/gdocs/owned/file.gdoc.json",
                     directory="/gdocs/owned/file.gdoc.json"), index)


@pytest.mark.asyncio
async def test_readdir_invalid_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/bogus", "/gdocs"),
                     virtual="/gdocs/bogus",
                     directory="/gdocs/bogus"), index)


@pytest.mark.asyncio
async def test_readdir_owned_pushes_modified_range(accessor, index):
    captured = {}

    async def fake_list(token_manager, mime_type=None, **kwargs):
        captured.update(kwargs)
        captured["mime_type"] = mime_type
        return []

    with patch("mirage.core.gdocs.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned/2026-05-*",
                                             "/gdocs"),
                     virtual="/gdocs/owned/2026-05-*",
                     directory="/gdocs/owned",
                     pattern="2026-05-*"), index)

    assert captured["modified_after"] == "2026-05-01T00:00:00Z"
    assert captured["modified_before"] == "2026-06-01T00:00:00Z"


@pytest.mark.asyncio
async def test_readdir_owned_filtered_does_not_cache(accessor, index):
    files = [{
        "id": "may",
        "name": "MayDoc",
        "modifiedTime": "2026-05-15T00:00:00.000Z",
        "owners": [{
            "me": True
        }]
    }]
    full_files = files + [{
        "id": "jan",
        "name": "JanDoc",
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

    with patch("mirage.core.gdocs.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned/2026-05-*",
                                             "/gdocs"),
                     virtual="/gdocs/owned/2026-05-*",
                     directory="/gdocs/owned",
                     pattern="2026-05-*"), index)
        result = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                     virtual="/gdocs/owned",
                     directory="/gdocs/owned"), index)

    assert call_count["n"] == 2
    assert len(result) == 2


@pytest.mark.asyncio
async def test_readdir_owned_filtered_bypasses_warm_cache(accessor, index):
    full_files = [
        {
            "id": "may",
            "name": "MayDoc",
            "modifiedTime": "2026-05-15T00:00:00.000Z",
            "owners": [{
                "me": True
            }]
        },
        {
            "id": "jan",
            "name": "JanDoc",
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

    with patch("mirage.core.gdocs.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                     virtual="/gdocs/owned",
                     directory="/gdocs/owned"), index)
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned/2026-05-*",
                                             "/gdocs"),
                     virtual="/gdocs/owned/2026-05-*",
                     directory="/gdocs/owned",
                     pattern="2026-05-*"), index)

    assert call_count["n"] == 2


@pytest.mark.asyncio
async def test_readdir_owned_no_pattern_omits_range(accessor, index):
    captured = {}

    async def fake_list(token_manager, mime_type=None, **kwargs):
        captured.update(kwargs)
        return []

    with patch("mirage.core.gdocs.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                     virtual="/gdocs/owned",
                     directory="/gdocs/owned"), index)

    assert captured.get("modified_after") is None
    assert captured.get("modified_before") is None


@pytest.mark.asyncio
async def test_readdir_owned_non_date_pattern_omits_range(accessor, index):
    captured = {}

    async def fake_list(token_manager, mime_type=None, **kwargs):
        captured.update(kwargs)
        return []

    with patch("mirage.core.gdocs.readdir.list_all_files", new=fake_list):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned/*foo*", "/gdocs"),
                     virtual="/gdocs/owned/*foo*",
                     directory="/gdocs/owned",
                     pattern="*foo*"), index)

    assert captured.get("modified_after") is None
    assert captured.get("modified_before") is None


@pytest.mark.asyncio
async def test_readdir_filtered_then_stat_succeeds(accessor, index):
    files = [{
        "id": "may1",
        "name": "MayDoc",
        "modifiedTime": "2026-05-15T00:00:00.000Z",
        "owners": [{
            "me": False
        }]
    }]
    with patch(
            "mirage.core.gdocs.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        listed = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/shared/2026-05-*",
                                             "/gdocs"),
                     virtual="/gdocs/shared/2026-05-*",
                     directory="/gdocs/shared",
                     pattern="2026-05-*"), index)
    assert len(listed) == 1
    matched = listed[0]
    result = await stat(
        accessor,
        PathSpec(resource_path=mount_key(matched, "/gdocs"),
                 virtual=matched,
                 directory=matched),
        index,
    )
    assert result.extra["doc_id"] == "may1"


@pytest.mark.asyncio
async def test_readdir_owned_newest_first_across_cache(accessor, index):
    """Relies on API mock newest-first, mirroring orderBy modifiedTime desc."""
    files = [
        {
            "id": "new",
            "name": "Latest",
            "modifiedTime": "2026-05-03T00:00:00.000Z",
            "owners": [{
                "me": True
            }]
        },
        {
            "id": "mid",
            "name": "Middle",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{
                "me": True
            }]
        },
        {
            "id": "old",
            "name": "Oldest",
            "modifiedTime": "2026-01-01T00:00:00.000Z",
            "owners": [{
                "me": True
            }]
        },
    ]
    with patch(
            "mirage.core.gdocs.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ) as mock_list:
        first = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                     virtual="/gdocs/owned",
                     directory="/gdocs/owned"), index)
        second = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                     virtual="/gdocs/owned",
                     directory="/gdocs/owned"), index)
        assert mock_list.call_count == 1
    assert first == second
    assert "new" in first[0]
    assert "mid" in first[1]
    assert "old" in first[-1]


@pytest.mark.asyncio
async def test_readdir_entry_size_none_source_size_in_extra(accessor, index):
    files = [
        {
            "id": "doc1",
            "name": "My Doc",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "size": "1234",
            "owners": [{
                "me": True
            }],
        },
    ]
    with patch(
            "mirage.core.gdocs.readdir.list_all_files",
            new_callable=AsyncMock,
            return_value=files,
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                     virtual="/gdocs/owned",
                     directory="/gdocs/owned"), index)

    # Drive's source size never becomes the entry size: the rendered
    # JSON length is unknown until read.
    entry = (await index.get(result[0])).entry
    assert entry.size is None
    assert entry.extra["source_size"] == 1234
