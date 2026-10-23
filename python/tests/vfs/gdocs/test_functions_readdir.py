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
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdocs import GDocsVFS
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import serve
from tests.fixtures.mounted import Mounted
from tests.fixtures.vfs_io import call_over


def _op(name: str):
    return call_over(GDocsVFS, name)


readdir = _op("readdir")


def _scope(path: str, prefix: str = "/gdocs") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


@pytest.fixture
def accessor():
    return GDocsAccessor(config=None, token_manager=None)


@pytest.mark.asyncio
async def test_readdir_root(accessor):
    result = await readdir(accessor, _scope("/gdocs"))
    assert [row.name for row in result] == ["owned", "shared"]


@pytest.mark.asyncio
async def test_a_listed_corpus_is_listed_once(accessor):
    mounted = Mounted(GDocsVFS, accessor, "/gdocs")
    listed = AsyncMock(
        return_value=(
            [
                {
                    "mimeType": "application/vnd.google-apps.document",
                    "id": "doc1",
                    "name": "Report",
                    "modifiedTime": "2026-04-01T00:00:00Z",
                    "owners": [{"me": True}],
                }
            ],
            True,
        )
    )
    with serve(drive=StubDrive(list_all_files=listed)):
        first = await mounted.readdir(_scope("/gdocs/owned"))
        again = await mounted.readdir(_scope("/gdocs/owned"))
    assert first == again and len(first) == 1
    assert "doc1" in first[0]
    listed.assert_awaited_once()
