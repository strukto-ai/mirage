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
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.gdocs.unlink import unlink
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GDocsAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_unlink_calls_delete_with_doc_id(accessor, index):
    await index.set_dir("/gdocs/owned", [
        ("foo.gdoc.json",
         IndexEntry(id="doc1",
                    name="Foo",
                    resource_type="gdocs/file",
                    vfs_name="foo.gdoc.json")),
    ])
    with patch("mirage.core.gdocs.unlink.delete_file",
               new_callable=AsyncMock) as mock_delete:
        await unlink(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned/foo.gdoc.json",
                                             "/gdocs"),
                     virtual="/gdocs/owned/foo.gdoc.json",
                     directory="/gdocs/owned/foo.gdoc.json"), index)
        mock_delete.assert_awaited_once()
        assert mock_delete.await_args.args[1] == "doc1"
    listing = await index.list_dir("/gdocs/owned")
    assert listing.entries is None or listing.entries == []


@pytest.mark.asyncio
async def test_unlink_virtual_dir_raises(accessor, index):
    with pytest.raises(IsADirectoryError):
        await unlink(
            accessor,
            PathSpec(resource_path=mount_key("/gdocs/owned", "/gdocs"),
                     virtual="/gdocs/owned",
                     directory="/gdocs/owned"), index)


@pytest.mark.asyncio
async def test_unlink_missing_raises(accessor, index):
    files = []
    with patch("mirage.core.gdocs.readdir.list_all_files",
               new_callable=AsyncMock,
               return_value=files):
        with pytest.raises(FileNotFoundError):
            await unlink(
                accessor,
                PathSpec(resource_path=mount_key("/gdocs/owned/nope.gdoc.json",
                                                 "/gdocs"),
                         virtual="/gdocs/owned/nope.gdoc.json",
                         directory="/gdocs/owned/nope.gdoc.json"), index)
