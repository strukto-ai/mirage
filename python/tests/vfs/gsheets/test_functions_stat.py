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

import pytest

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.cache.index.config import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gsheets import GSheetsVFS
from tests.fixtures.vfs_io import call_over


def _op(name: str):
    return call_over(GSheetsVFS, name)


stat = _op("stat")


def _scope(path: str, prefix: str = "/gsheets") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.fixture
def accessor():
    return GSheetsAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root_is_directory(accessor, index):
    result = await stat(accessor, _scope("/gsheets"), index=index)
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_sheet(accessor, index):
    await index.set_dir(
        "/gsheets/owned",
        [
            (
                "Budget__sheet1.gsheet.json",
                IndexEntry(
                    id="sheet1",
                    name="Budget",
                    resource_type="gsheets/sheet",
                    remote_time="2026-04-01T00:00:00Z",
                    vfs_name="Budget__sheet1.gsheet.json",
                ),
            )
        ],
    )
    result = await stat(
        accessor,
        _scope("/gsheets/owned/Budget__sheet1.gsheet.json"),
        index=index,
    )
    assert result.name == "Budget__sheet1.gsheet.json"
    assert result.extra["doc_id"] == "sheet1"


@pytest.mark.asyncio
async def test_stat_not_found(accessor, index):
    await index.set_dir("/gsheets/owned", [])
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            _scope("/gsheets/owned/Nonexistent__sheet9.gsheet.json"),
            index=index,
        )
