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

import errno

import pytest

from mirage.accessor.gdocs import GDocsAccessor
from mirage.core.gdocs.rename import rename
from mirage.core.google.rename import app_title
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.google_account import FILE

MIME = "application/vnd.google-apps.document"
MODIFIED = "2026-10-01T09:00:00.000Z"
OLD = "2026-10-01_Old_Plan__doc1.gdoc.json"
NEW = "2026-10-01_New_Plan__doc1.gdoc.json"


def spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/gdocs"),
        virtual=virtual,
        directory=virtual,
    )


async def _plan(google_account) -> str:
    made = await google_account.create("Old Plan", MIME)
    await google_account.patch(made, modifiedTime=MODIFIED)
    await google_account.run.record_requests()
    return made


async def renamed(google_account, made: str, dst: str) -> None:
    old = f"2026-10-01_Old_Plan__{made}.gdoc.json"
    entry = FileStat(
        name=old,
        type=FileType.FILE,
        modified=MODIFIED,
        extra={"doc_id": made, "doc_name": "Old Plan"},
    )
    manager = google_account.token_manager()
    await rename(
        GDocsAccessor(config=manager.config, token_manager=manager),
        spec(f"/gdocs/owned/{old}"),
        spec(dst),
        entry,
    )


@pytest.mark.parametrize(
    ("name", "title"),
    [
        (NEW, "New_Plan"),
        ("2026-09-30_New__doc1.gdoc.json", None),
        ("2026-10-01_New__doc2.gdoc.json", None),
        ("2026-10-01_New Plan__doc1.gdoc.json", None),
    ],
)
def test_only_a_name_the_listing_renders_back_gives_a_title(name, title):
    assert app_title(name, "doc1", MODIFIED, ".gdoc.json") == title


@pytest.mark.asyncio
async def test_rename_sets_the_title_and_keeps_the_modified_time(
    google_account,
):
    made = await _plan(google_account)
    await renamed(
        google_account,
        made,
        f"/gdocs/owned/2026-10-01_New_Plan__{made}.gdoc.json",
    )
    assert await google_account.run.bodies("PATCH", FILE) == [
        {"name": "New_Plan", "modifiedTime": MODIFIED}
    ]
    item = await google_account.item(made)
    assert (item["name"], item["modifiedTime"]) == ("New_Plan", MODIFIED)


@pytest.mark.parametrize("dst", ["owned/New_Plan.gdoc.json", "shared/new"])
@pytest.mark.asyncio
async def test_a_name_the_listing_cannot_render_is_eperm(google_account, dst):
    made = await _plan(google_account)
    if dst == "shared/new":
        dst = f"shared/2026-10-01_New_Plan__{made}.gdoc.json"
    with pytest.raises(OSError) as raised:
        await renamed(google_account, made, f"/gdocs/{dst}")
    assert raised.value.errno == errno.EPERM
    assert await google_account.run.bodies("PATCH", FILE) == []
