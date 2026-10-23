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
from mirage.core.gdocs.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdocs import GDocsVFS
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import serve
from tests.fixtures.mounted import Mounted


@pytest.fixture
def accessor():
    return GDocsAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/gdocs", "/gdocs"),
            virtual="/gdocs",
            directory="/gdocs",
        ),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_owned_dir(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/gdocs/owned", "/gdocs"),
            virtual="/gdocs/owned",
            directory="/gdocs/owned",
        ),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "owned"


@pytest.mark.asyncio
async def test_stat_shared_dir(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/gdocs/shared", "/gdocs"),
            virtual="/gdocs/shared",
            directory="/gdocs/shared",
        ),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "shared"


@pytest.mark.asyncio
async def test_stat_doc(accessor):
    item = {
        "mimeType": "application/vnd.google-apps.document",
        "id": "doc1",
        "name": "My Doc",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [{"me": True}],
        "size": "1000",
    }
    mounted = Mounted(GDocsVFS, accessor, "/gdocs")
    with serve(
        drive=StubDrive(list_all_files=AsyncMock(return_value=([item], True)))
    ):
        (target,) = await mounted.readdir("/owned")
        result = await mounted.stat(target.removeprefix("/gdocs"))
    assert result.name == "2026-04-01_My_Doc__doc1.gdoc.json"
    assert result.content == ContentType.JSON
    assert result.modified == "2026-04-01T00:00:00.000Z"
    assert result.fingerprint == "2026-04-01T00:00:00.000Z"
    assert result.extra["doc_id"] == "doc1"
    assert result.extra["doc_name"] == "My Doc"
    # rendered JSON length is unknown until read; the Drive source size
    # is surfaced via extra only
    assert result.size is None
    assert result.extra["source_size"] == 1000


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    files = [
        {
            "mimeType": "application/vnd.google-apps.document",
            "id": "doc1",
            "name": "My Doc",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "owners": [{"me": True}],
        }
    ]
    with serve(drive=StubDrive(get_file=AsyncMock(return_value=files[0]))):
        with pytest.raises(FileNotFoundError):
            await stat(
                accessor,
                PathSpec(
                    vfs_path=mount_key(
                        "/gdocs/owned/nonexistent.gdoc.json", "/gdocs"
                    ),
                    virtual="/gdocs/owned/nonexistent.gdoc.json",
                    directory="/gdocs/owned/nonexistent.gdoc.json",
                ),
            )


@pytest.mark.asyncio
async def test_stat_cache_miss_fetches_metadata_by_id(accessor):
    files = [
        {
            "mimeType": "application/vnd.google-apps.document",
            "id": "doc1",
            "name": "My Doc",
            "modifiedTime": "2026-04-01T00:00:00.000Z",
            "size": "1234",
            "owners": [{"me": True}],
        }
    ]
    target = "/gdocs/owned/2026-04-01_My_Doc__doc1.gdoc.json"
    mock_list = AsyncMock(return_value=files[0])
    with serve(drive=StubDrive(get_file=mock_list)):
        result = await stat(
            accessor,
            PathSpec(
                vfs_path=mount_key(target, "/gdocs"),
                virtual=target,
                directory=target,
            ),
        )
    assert result.content == ContentType.JSON
    assert result.extra["doc_id"] == "doc1"
    assert result.size is None
    assert result.extra["source_size"] == 1234
    assert mock_list.call_count == 1
