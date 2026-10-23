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
from mirage.core.gdocs.unlink import unlink
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import serve


@pytest.fixture
def accessor():
    return GDocsAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_unlink_calls_delete_with_doc_id(accessor):
    mock_delete = AsyncMock()
    with serve(drive=StubDrive(delete_file=mock_delete)):
        await unlink(
            accessor,
            PathSpec(
                vfs_path=mount_key(
                    "/gdocs/owned/Foo__doc1.gdoc.json", "/gdocs"
                ),
                virtual="/gdocs/owned/Foo__doc1.gdoc.json",
                directory="/gdocs/owned/Foo__doc1.gdoc.json",
            ),
            FileStat(name="Foo__doc1.gdoc.json", type=FileType.FILE),
        )
        mock_delete.assert_awaited_once()
        assert mock_delete.await_args.args[0] == "doc1"


@pytest.mark.asyncio
async def test_unlink_virtual_dir_raises(accessor):
    with pytest.raises(IsADirectoryError):
        await unlink(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gdocs/owned", "/gdocs"),
                virtual="/gdocs/owned",
                directory="/gdocs/owned",
            ),
        )


@pytest.mark.asyncio
async def test_unlink_missing_raises(accessor):
    files = []
    with serve(
        drive=StubDrive(list_all_files=AsyncMock(return_value=(files, True)))
    ):
        with pytest.raises(FileNotFoundError):
            await unlink(
                accessor,
                PathSpec(
                    vfs_path=mount_key(
                        "/gdocs/owned/Nope__doc9.gdoc.json", "/gdocs"
                    ),
                    virtual="/gdocs/owned/Nope__doc9.gdoc.json",
                    directory="/gdocs/owned/Nope__doc9.gdoc.json",
                ),
            )
