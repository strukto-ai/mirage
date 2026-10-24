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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.types import FileStat, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdocs import GDocsVFS
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import offline_token_manager, serve
from tests.fixtures.mounted import Mounted


@pytest.fixture
def accessor():
    return GDocsAccessor(config=None, token_manager=offline_token_manager())


@pytest.fixture
def mounted(accessor):
    return Mounted(GDocsVFS, accessor, "/gdocs")


async def readdir(
    accessor: GDocsAccessor, path: PathSpec, mounted: Mounted
) -> list[str]:
    return await mounted.readdir(path)


async def stat(
    accessor: GDocsAccessor, path: PathSpec, mounted: Mounted
) -> FileStat:
    return await mounted.stat(path)


@pytest.mark.asyncio
async def test_readdir_root(accessor, mounted):
    result = await readdir(
        accessor,
        PathSpec(
            vfs_path=mount_key("/gdocs", "/gdocs"),
            virtual="/gdocs",
            directory="/gdocs",
        ),
        mounted,
    )
    assert result == ["/gdocs/owned", "/gdocs/shared"]


@pytest.mark.asyncio
async def test_readdir_owned(accessor, mounted):
    files = [
        {
            "id": "doc1",
            "name": "My Doc",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{"me": True}],
        },
    ]
    with serve(
        drive=StubDrive(list_all_files=AsyncMock(return_value=(files, True)))
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned", "/gdocs"),
                virtual="/gdocs/owned",
                directory="/gdocs/owned",
            ),
            mounted,
        )
        assert len(result) == 1
        assert "doc1" in result[0]


@pytest.mark.asyncio
async def test_readdir_shared(accessor, mounted):
    files = [
        {
            "id": "doc2",
            "name": "Shared Doc",
            "modifiedTime": "2026-03-15T00:00:00.000Z",
            "owners": [{"me": False}],
        },
    ]
    with serve(
        drive=StubDrive(list_all_files=AsyncMock(return_value=(files, True)))
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/shared", "/gdocs"),
                virtual="/gdocs/shared",
                directory="/gdocs/shared",
            ),
            mounted,
        )
        assert len(result) == 1
        assert "doc2" in result[0]


@pytest.mark.asyncio
async def test_readdir_file_path_raises(accessor, mounted):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned/file.gdoc.json", "/gdocs"),
                virtual="/gdocs/owned/file.gdoc.json",
                directory="/gdocs/owned/file.gdoc.json",
            ),
            mounted,
        )


@pytest.mark.asyncio
async def test_readdir_invalid_path_raises(accessor, mounted):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/bogus", "/gdocs"),
                virtual="/gdocs/bogus",
                directory="/gdocs/bogus",
            ),
            mounted,
        )


@pytest.mark.asyncio
async def test_readdir_owned_pushes_modified_range(accessor, mounted):
    captured = {}

    async def fake_list(mime_type=None, **kwargs):
        captured.update(kwargs)
        captured["mime_type"] = mime_type
        return [], True

    with serve(drive=StubDrive(list_all_files=fake_list)):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned/2026-05-*", "/gdocs"),
                virtual="/gdocs/owned/2026-05-*",
                directory="/gdocs/owned",
                pattern="2026-05-*",
            ),
            mounted,
        )

    assert captured["modified_after"] == "2026-05-01T00:00:00Z"
    assert captured["modified_before"] == "2026-06-01T00:00:00Z"


@pytest.mark.asyncio
async def test_readdir_owned_filtered_does_not_cache(accessor, mounted):
    files = [
        {
            "id": "may",
            "name": "MayDoc",
            "modifiedTime": "2026-05-15T00:00:00.000Z",
            "owners": [{"me": True}],
        }
    ]
    full_files = files + [
        {
            "id": "jan",
            "name": "JanDoc",
            "modifiedTime": "2026-01-15T00:00:00.000Z",
            "owners": [{"me": True}],
        }
    ]

    call_count = {"n": 0}

    async def fake_list(
        mime_type=None,
        modified_after=None,
        modified_before=None,
        **kwargs,
    ):
        call_count["n"] += 1
        if modified_after:
            return files, True
        return full_files, True

    with serve(drive=StubDrive(list_all_files=fake_list)):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned/2026-05-*", "/gdocs"),
                virtual="/gdocs/owned/2026-05-*",
                directory="/gdocs/owned",
                pattern="2026-05-*",
            ),
            mounted,
        )
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned", "/gdocs"),
                virtual="/gdocs/owned",
                directory="/gdocs/owned",
            ),
            mounted,
        )

    assert call_count["n"] == 2
    assert len(result) == 2


@pytest.mark.asyncio
async def test_readdir_owned_glob_matches_a_whole_listing(accessor, mounted):
    full_files = [
        {
            "id": "may",
            "name": "MayDoc",
            "modifiedTime": "2026-05-15T00:00:00.000Z",
            "owners": [{"me": True}],
        },
        {
            "id": "jan",
            "name": "JanDoc",
            "modifiedTime": "2026-01-15T00:00:00.000Z",
            "owners": [{"me": True}],
        },
    ]
    may_only = [full_files[0]]

    call_count = {"n": 0}

    async def fake_list(
        mime_type=None,
        modified_after=None,
        modified_before=None,
        **kwargs,
    ):
        call_count["n"] += 1
        if modified_after:
            return may_only, True
        return full_files, True

    with serve(drive=StubDrive(list_all_files=fake_list)):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned", "/gdocs"),
                virtual="/gdocs/owned",
                directory="/gdocs/owned",
            ),
            mounted,
        )
        matched = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned/2026-05-*", "/gdocs"),
                virtual="/gdocs/owned/2026-05-*",
                directory="/gdocs/owned",
                pattern="2026-05-*",
            ),
            mounted,
        )

    # The whole corpus is already listed, so the glob is matched against
    # it rather than asked of Drive again.
    assert call_count["n"] == 1
    assert len(matched) == 1 and "may" in matched[0]


@pytest.mark.asyncio
async def test_readdir_owned_no_pattern_omits_range(accessor, mounted):
    captured = {}

    async def fake_list(mime_type=None, **kwargs):
        captured.update(kwargs)
        return [], True

    with serve(drive=StubDrive(list_all_files=fake_list)):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned", "/gdocs"),
                virtual="/gdocs/owned",
                directory="/gdocs/owned",
            ),
            mounted,
        )

    assert captured.get("modified_after") is None
    assert captured.get("modified_before") is None


@pytest.mark.asyncio
async def test_readdir_owned_non_date_pattern_omits_range(accessor, mounted):
    captured = {}

    async def fake_list(mime_type=None, **kwargs):
        captured.update(kwargs)
        return [], True

    with serve(drive=StubDrive(list_all_files=fake_list)):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned/*foo*", "/gdocs"),
                virtual="/gdocs/owned/*foo*",
                directory="/gdocs/owned",
                pattern="*foo*",
            ),
            mounted,
        )

    assert captured.get("modified_after") is None
    assert captured.get("modified_before") is None


@pytest.mark.asyncio
async def test_readdir_filtered_then_stat_succeeds(accessor, mounted):
    files = [
        {
            "id": "may1",
            "mimeType": "application/vnd.google-apps.document",
            "name": "MayDoc",
            "modifiedTime": "2026-05-15T00:00:00.000Z",
            "owners": [{"me": False}],
        }
    ]
    mock_list = AsyncMock(return_value=(files, True))
    mock_get = AsyncMock(return_value=files[0])
    with (
        serve(drive=StubDrive(list_all_files=mock_list, get_file=mock_get)),
    ):
        listed = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/shared/2026-05-*", "/gdocs"),
                virtual="/gdocs/shared/2026-05-*",
                directory="/gdocs/shared",
                pattern="2026-05-*",
            ),
            mounted,
        )
        assert len(listed) == 1
        matched = listed[0]
        result = await stat(
            accessor,
            PathSpec(
                vfs_path=mount_key(matched, "/gdocs"),
                virtual=matched,
                directory=matched,
            ),
            mounted,
        )
    assert result.extra["doc_id"] == "may1"
    # The filtered result is not the directory, but the rows it lists
    # are real, so the stat is answered from them.
    assert mock_list.await_count == 1
    mock_get.assert_not_awaited()


@pytest.mark.asyncio
async def test_readdir_owned_newest_first_across_cache(accessor, mounted):
    """Relies on API mock newest-first, mirroring orderBy modifiedTime desc."""
    files = [
        {
            "id": "new",
            "name": "Latest",
            "modifiedTime": "2026-05-03T00:00:00.000Z",
            "owners": [{"me": True}],
        },
        {
            "id": "mid",
            "name": "Middle",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{"me": True}],
        },
        {
            "id": "old",
            "name": "Oldest",
            "modifiedTime": "2026-01-01T00:00:00.000Z",
            "owners": [{"me": True}],
        },
    ]
    mock_list = AsyncMock(return_value=(files, True))
    with serve(drive=StubDrive(list_all_files=mock_list)):
        first = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned", "/gdocs"),
                virtual="/gdocs/owned",
                directory="/gdocs/owned",
            ),
            mounted,
        )
        second = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned", "/gdocs"),
                virtual="/gdocs/owned",
                directory="/gdocs/owned",
            ),
            mounted,
        )
        assert mock_list.call_count == 1
    assert first == second
    assert "new" in first[0]
    assert "mid" in first[1]
    assert "old" in first[-1]


@pytest.mark.asyncio
async def test_readdir_entry_size_none_source_size_in_extra(accessor, mounted):
    files = [
        {
            "id": "doc1",
            "name": "My Doc",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "size": "1234",
            "owners": [{"me": True}],
        },
    ]
    with serve(
        drive=StubDrive(list_all_files=AsyncMock(return_value=(files, True)))
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned", "/gdocs"),
                virtual="/gdocs/owned",
                directory="/gdocs/owned",
            ),
            mounted,
        )

    # Drive's source size never becomes the row's size: the rendered
    # JSON length is unknown until read.
    row = await mounted.stat(
        PathSpec.from_str_path(result[0], mount_key(result[0], "/gdocs"))
    )
    assert row.size is None
    assert row.extra["source_size"] == 1234


@pytest.mark.asyncio
async def test_readdir_incomplete_search_is_not_cached_as_the_directory(
    accessor, mounted
):
    """Drive reporting a corpus it skipped means the listing is short.

    Keeping it would pin the short listing until it expires, so a Shared
    Drive document stays invisible long after the cause clears: the next
    listing asks Drive again until one finishes.
    """
    files = [
        {
            "id": "d1",
            "name": "Doc",
            "modifiedTime": "2026-05-15T00:00:00.000Z",
            "owners": [{"me": True}],
        }
    ]
    complete = {"v": False}

    async def fake_list(mime_type=None, **kwargs):
        return files, complete["v"]

    owned = PathSpec(
        vfs_path=mount_key("/gdocs/owned", "/gdocs"),
        virtual="/gdocs/owned",
        directory="/gdocs/owned",
    )
    listings = AsyncMock(side_effect=fake_list)
    with serve(drive=StubDrive(list_all_files=listings)):
        listed = await readdir(accessor, owned, mounted)
        assert len(listed) == 1
        await readdir(accessor, owned, mounted)
        assert listings.await_count == 2

        complete["v"] = True
        await readdir(accessor, owned, mounted)
        await readdir(accessor, owned, mounted)
        assert listings.await_count == 3
