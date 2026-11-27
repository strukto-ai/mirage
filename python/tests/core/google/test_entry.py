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
from mirage.cache.index.scope import command_scope
from mirage.core.google.client import GoogleApiError
from mirage.core.google.entry import resolve_app_entry
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.types import PathSpec
from mirage.utils.clock import ManualClock
from mirage.vfs.gdocs import GDocsVFS
from mirage.vfs.gdocs.doc_entry import make_filename
from tests.fixtures.google_account import FILE, FILES, UNTIL_CLEARED
from tests.fixtures.mounted import Mounted

MIME = "application/vnd.google-apps.document"
MODIFIED = "2026-04-01T12:00:00.000Z"


async def _notes(google_account) -> tuple[str, str, PathSpec, ScopeMatch]:
    """A doc named Notes stamped ``MODIFIED``: its id, its name on the
    mount, its path in the owned corpus, and the scope the path matches.

    Args:
        google_account (GoogleAccount): the account it is made in.
    """
    made = await google_account.create("Notes", MIME)
    await google_account.patch(made, modifiedTime=MODIFIED)
    name = make_filename("Notes", made, MODIFIED)
    path = PathSpec(
        directory="/docs/owned/" + name,
        virtual="/docs/owned/" + name,
        vfs_path="owned/" + name,
    )
    match = ScopeMatch(
        kind="file",
        vfs_path=path.vfs_path,
        slots={"corpus": "owned", "file_id": made},
    )
    return made, name, path, match


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
async def test_a_direct_lookup_proves_the_file(google_account, outcome):
    made, _, path, match = await _notes(google_account)
    item = await google_account.item(made)
    if outcome == "updated":
        # Drive's own answer with the source size it gives a native file,
        # which the fake keeps none of.
        await google_account.run.answer_next(
            "GET", FILE, 200, {**item, "size": "1000"}
        )
    if outcome == "renamed":
        await google_account.patch(made, name="Renamed")
    if outcome == "date":
        await google_account.patch(made, modifiedTime="2026-04-02T12:00:00Z")
    if outcome == "trashed":
        await google_account.patch(made, trashed=True)
    if outcome == "mime":
        await google_account.run.answer_next(
            "GET", FILE, 200, {**item, "mimeType": "text/plain"}
        )
    if outcome == "owner":
        # Shared with the account by another: Drive names no owner it is.
        await google_account.run.answer_next(
            "GET", FILE, 200, {**item, "owners": []}
        )
    if outcome == "deleted":
        await google_account.delete(made)
    if outcome == "forbidden":
        await google_account.refuse("GET", FILE, 403, "forbidden")
    if outcome == "unavailable":
        await google_account.refuse(
            "GET",
            FILE,
            503,
            "unavailable",
            reason="backendError",
            times=UNTIL_CLEARED,
        )
    drive = google_account.drive_accessor(ManualClock()).drive
    await google_account.run.record_requests()
    if outcome == "updated":
        row = await resolve_app_entry(drive, match, path, MIME, make_filename)
        assert row.modified == MODIFIED
        assert row.size is None
        assert row.extra == {
            "doc_id": made,
            "doc_name": "Notes",
            "source_size": 1000,
        }
    elif outcome in ("forbidden", "unavailable"):
        with pytest.raises(GoogleApiError) as raised:
            await resolve_app_entry(drive, match, path, MIME, make_filename)
        assert str(raised.value) == outcome
    else:
        with pytest.raises(FileNotFoundError):
            await resolve_app_entry(drive, match, path, MIME, make_filename)
    asked = await google_account.log()
    assert set(asked) == {("get", made)}
    if outcome != "unavailable":
        assert len(asked) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("complete", [True, False])
async def test_only_a_complete_listing_proves_absence(
    google_account, complete
):
    made, name, _, _ = await _notes(google_account)
    # Drive answers no doc: proof of absence only when it finished.
    await google_account.run.answer_next(
        "GET", FILES, 200, {"files": [], "incompleteSearch": not complete}
    )
    manager = google_account.token_manager()
    mounted = Mounted(
        GDocsVFS, GDocsAccessor(config=manager.config, token_manager=manager)
    )
    await google_account.run.record_requests()
    # One command lists and stats, so its own complete listing is proof.
    async with command_scope():
        await mounted.readdir("/owned")
        if complete:
            with pytest.raises(FileNotFoundError):
                await mounted.stat("/owned/" + name)
            assert ("get", made) not in await google_account.log()
        else:
            row = await mounted.stat("/owned/" + name)
            assert row.extra["doc_id"] == made
            gets = [d for n, d in await google_account.log() if n == "get"]
            assert gets == [made]
