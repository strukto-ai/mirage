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
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gsheets import GSheetsVFS
from tests.fixtures.mounted import Mounted
from tests.fixtures.vfs_io import call_over

stat = call_over(GSheetsVFS, "stat")

APP = "/gsheets"
MIME = "application/vnd.google-apps.spreadsheet"


def _scope(path: str, prefix: str = APP) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


def _accessor(google_account) -> GSheetsAccessor:
    manager = google_account.token_manager()
    return GSheetsAccessor(config=manager.config, token_manager=manager)


@pytest.mark.asyncio
async def test_stat_root_is_directory(google_account):
    result = await stat(_accessor(google_account), _scope(APP))
    assert result.name == "/"
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_sheet(google_account):
    made = await google_account.create("Budget", MIME)
    mounted = Mounted(GSheetsVFS, _accessor(google_account), APP)
    (target,) = await mounted.readdir(_scope(f"{APP}/owned"))
    result = await mounted.stat(_scope(target))
    assert result.name == target.rsplit("/", 1)[-1]
    assert result.extra["doc_id"] == made


@pytest.mark.asyncio
async def test_stat_not_found(google_account):
    mounted = Mounted(GSheetsVFS, _accessor(google_account), APP)
    await mounted.readdir(_scope(f"{APP}/owned"))
    with pytest.raises(FileNotFoundError):
        await mounted.stat(_scope(f"{APP}/owned/Nonexistent__x9.json"))
