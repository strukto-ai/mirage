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

from urllib.parse import parse_qs

import pytest

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.google.readdir import make_app_readdir
from mirage.core.gsheets.constants import MIME
from mirage.core.gsheets.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.google_account import FILES


def _name(title: str, file_id: str, modified: str) -> str:
    return f"{title}.{file_id}.{modified[:4]}"


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/m"), virtual=virtual, directory=virtual
    )


def _accessor(google_account) -> GoogleApiAccessor:
    manager = google_account.token_manager()
    return GoogleApiAccessor(manager.config, manager)


READDIR = make_app_readdir(MIME, detect_scope, _name)


@pytest.mark.asyncio
async def test_a_corpus_lists_its_owners_files_through_the_apps_namer(
    google_account,
):
    mine = await google_account.create("Mine", MIME)
    await google_account.patch(mine, modifiedTime="2026-04-01T00:00:00.000Z")
    theirs = await google_account.create("Theirs", MIME)
    # Every file the fake holds is the account's own; Drive names another
    # owner for one shared with it, and gives a native file's size.
    listing = await google_account.run.call(
        "GET", FILES, params={"q": f"mimeType = '{MIME}'"}
    )
    files = []
    for row in listing["files"]:
        if row["id"] == mine:
            row = {**row, "size": "12"}
        if row["id"] == theirs:
            row = {**row, "owners": [{"me": False}]}
        files.append(row)
    await google_account.run.answer_next(
        "GET", FILES, 200, {**listing, "files": files}
    )
    await google_account.run.record_requests()
    out = await READDIR(_accessor(google_account), _spec("/m/owned"))
    (row,) = out.entries
    assert out.partial is False
    assert row.name == f"Mine.{mine}.2026"
    (asked,) = await google_account.asked("GET", FILES)
    assert f"mimeType='{MIME}'" in parse_qs(asked["query"])["q"][0]
    assert row.size is None
    assert row.extra == {"doc_id": mine, "doc_name": "Mine", "source_size": 12}


@pytest.mark.asyncio
async def test_the_root_lists_the_corpora_without_a_request(google_account):
    await google_account.run.record_requests()
    out = await READDIR(_accessor(google_account), _spec("/m"))
    assert [row.name for row in out] == ["owned", "shared"]
    assert await google_account.log() == []
