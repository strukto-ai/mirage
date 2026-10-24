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

from mirage.accessor.gsheets import GSheetsAccessor
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gsheets import GSheetsVFS
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import offline_token_manager, serve
from tests.fixtures.mounted import Mounted
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
    return GSheetsAccessor(config=None, token_manager=offline_token_manager())


@pytest.mark.asyncio
async def test_stat_root_is_directory(accessor):
    result = await stat(accessor, _scope("/gsheets"))
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_sheet(accessor):
    mounted = Mounted(GSheetsVFS, accessor, "/gsheets")
    with serve(
        drive=StubDrive(
            list_all_files=AsyncMock(
                return_value=(
                    [
                        {
                            "mimeType": "application/vnd.google-apps.spreadsheet",
                            "id": "sheet1",
                            "name": "Budget",
                            "modifiedTime": "2026-04-01T00:00:00Z",
                            "owners": [{"me": True}],
                        }
                    ],
                    True,
                )
            )
        )
    ):
        (target,) = await mounted.readdir(_scope("/gsheets/owned"))
        result = await mounted.stat(_scope(target))
    assert result.name == target.rsplit("/", 1)[-1]
    assert result.extra["doc_id"] == "sheet1"


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    mounted = Mounted(GSheetsVFS, accessor, "/gsheets")
    with serve(
        drive=StubDrive(list_all_files=AsyncMock(return_value=([], True)))
    ):
        await mounted.readdir(_scope("/gsheets/owned"))
        with pytest.raises(FileNotFoundError):
            await mounted.stat(_scope("/gsheets/owned/Nonexistent__x9.json"))
