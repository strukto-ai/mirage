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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdocs import GDocsVFS
from tests.fixtures.google_account import FILES
from tests.fixtures.mounted import Mounted
from tests.fixtures.vfs_io import call_over

readdir = call_over(GDocsVFS, "readdir")

APP = "/gdocs"
MIME = "application/vnd.google-apps.document"


def _scope(path: str, prefix: str = APP) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] or "/",
    )


def _accessor(google_account) -> GDocsAccessor:
    manager = google_account.token_manager()
    return GDocsAccessor(config=manager.config, token_manager=manager)


@pytest.mark.asyncio
async def test_readdir_root(google_account):
    result = await readdir(_accessor(google_account), _scope(APP))
    assert [row.name for row in result] == ["owned", "shared"]


@pytest.mark.asyncio
async def test_a_listed_corpus_is_listed_once(google_account):
    made = await google_account.create("Report", MIME)
    mounted = Mounted(GDocsVFS, _accessor(google_account), APP)
    await google_account.run.record_requests()
    first = await mounted.readdir(_scope(f"{APP}/owned"))
    again = await mounted.readdir(_scope(f"{APP}/owned"))
    assert first == again and len(first) == 1
    assert made in first[0]
    assert len(await google_account.asked("GET", FILES)) == 1
