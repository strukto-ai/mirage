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
from aiohttp import ClientResponseError

from mirage.accessor.gdocs import GDocsAccessor
from mirage.cache.index.scope import command_scope
from mirage.core.google.entry import resolve_app_entry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.types import PathSpec
from mirage.vfs.gdocs import GDocsVFS
from mirage.vfs.gdocs.doc_entry import make_filename
from tests.fixtures.gdrive_api import StubDrive
from tests.fixtures.google_api import offline_token_manager, serve
from tests.fixtures.mounted import Mounted

ITEM = {
    "id": "doc1",
    "name": "Notes",
    "mimeType": "application/vnd.google-apps.document",
    "modifiedTime": "2026-04-01T12:00:00Z",
    "owners": [{"me": True}],
    "size": "1000",
}
NAME = make_filename(ITEM["name"], ITEM["id"], ITEM["modifiedTime"])
PATH = PathSpec(
    directory="/docs/owned/" + NAME,
    virtual="/docs/owned/" + NAME,
    vfs_path="owned/" + NAME,
)
MATCH = ScopeMatch(
    kind="file",
    vfs_path=PATH.vfs_path,
    slots={"corpus": "owned", "file_id": "doc1"},
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome",
    [
        "updated",
        "renamed",
        "date",
        "trashed",
        "mime",
        "owner",
        "deleted",
        "forbidden",
        "unavailable",
    ],
)
async def test_a_direct_lookup_proves_the_file(outcome):
    item = dict(ITEM)
    error = None
    if outcome == "renamed":
        item["name"] = "Renamed"
    if outcome == "date":
        item["modifiedTime"] = "2026-04-02T12:00:00Z"
    if outcome == "trashed":
        item["trashed"] = True
    if outcome == "mime":
        item["mimeType"] = "text/plain"
    if outcome == "owner":
        item["owners"] = []
    if outcome in ("deleted", "forbidden", "unavailable"):
        error = ClientResponseError(
            None,
            (),
            status={"deleted": 404, "forbidden": 403, "unavailable": 503}[
                outcome
            ],
        )
    get = AsyncMock(return_value=item, side_effect=error)
    drive = StubDrive(get_file=get)
    if outcome == "updated":
        row = await resolve_app_entry(
            drive, MATCH, PATH, ITEM["mimeType"], make_filename
        )
        assert row.modified == ITEM["modifiedTime"]
        assert row.size is None
        assert row.extra == {
            "doc_id": "doc1",
            "doc_name": "Notes",
            "source_size": 1000,
        }
    elif outcome in ("forbidden", "unavailable"):
        with pytest.raises(ClientResponseError) as raised:
            await resolve_app_entry(
                drive, MATCH, PATH, ITEM["mimeType"], make_filename
            )
        assert raised.value is error
    else:
        with pytest.raises(FileNotFoundError):
            await resolve_app_entry(
                drive, MATCH, PATH, ITEM["mimeType"], make_filename
            )
    get.assert_awaited_once_with("doc1")


@pytest.mark.asyncio
@pytest.mark.parametrize("complete", [True, False])
async def test_only_a_complete_listing_proves_absence(complete):
    mounted = Mounted(
        GDocsVFS,
        GDocsAccessor(config=None, token_manager=offline_token_manager()),
    )
    get = AsyncMock(return_value=ITEM)
    with (
        serve(
            drive=StubDrive(
                list_all_files=AsyncMock(return_value=([], complete)),
                get_file=get,
            )
        ),
    ):
        # One command lists and stats, so its own complete listing is proof.
        async with command_scope():
            await mounted.readdir("/owned")
            if complete:
                with pytest.raises(FileNotFoundError):
                    await mounted.stat("/owned/" + NAME)
                get.assert_not_awaited()
            else:
                row = await mounted.stat("/owned/" + NAME)
                assert row.extra["doc_id"] == ITEM["id"]
                get.assert_awaited_once_with("doc1")
