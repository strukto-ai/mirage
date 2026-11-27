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
from mirage.core.gdocs.constants import MIME
from mirage.core.google.events import app_delta_hook
from mirage.types import FileChangeKind, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gdocs.doc_entry import make_filename

ROOT = PathSpec(
    vfs_path=mount_key("/gdocs", "/gdocs"),
    virtual="/gdocs",
    directory="/gdocs",
)
CHANGES = "/drive/v3/changes"
SHEET = "application/vnd.google-apps.spreadsheet"
FIRST = "2026-10-01T09:00:00.000Z"
SECOND = "2026-10-02T09:00:00.000Z"


async def _page_token(google_account) -> str:
    made = await google_account.run.call("GET", f"{CHANGES}/startPageToken")
    return str(made["startPageToken"])


async def _shared(google_account, since: str, shared: str) -> None:
    """Answer the next change read with the fake's own page, the doc
    ``shared`` in it owned by another: every file the fake holds is the
    account's own, and Drive names another owner for one shared with it.

    Args:
        google_account (GoogleAccount): the account.
        since (str): the page token the read starts from.
        shared (str): the doc shared with the account.
    """
    page = await google_account.run.call(
        "GET", CHANGES, params={"pageToken": since}
    )
    for change in page["changes"]:
        if change["fileId"] == shared and "file" in change:
            change["file"]["owners"] = [{"me": False}]
    await google_account.run.answer_next("GET", CHANGES, 200, page)


@pytest.mark.asyncio
async def test_changes_place_each_doc_where_the_app_lists_it(google_account):
    old = await google_account.create("Plan", MIME)
    sheet = await google_account.create("Budget", SHEET)
    manager = google_account.token_manager()
    hook = app_delta_hook(
        GDocsAccessor(config=manager.config, token_manager=manager),
        MIME,
        make_filename,
    )
    baseline = await hook.pull(ROOT, None)

    since = await _page_token(google_account)
    await google_account.patch(old, modifiedTime=FIRST)
    new = await google_account.create("Notes", MIME)
    await google_account.patch(sheet, modifiedTime=FIRST)
    made = (await google_account.item(new))["modifiedTime"]
    await _shared(google_account, since, new)
    first = await hook.pull(ROOT, baseline.checkpoint)

    since = await _page_token(google_account)
    await google_account.patch(old, modifiedTime=SECOND)
    await google_account.patch(new, trashed=True, modifiedTime=made)
    await google_account.delete(await google_account.create("Gone", MIME))
    await _shared(google_account, since, new)
    second = await hook.pull(ROOT, first.checkpoint)

    notes = f"/gdocs/shared/{make_filename('Notes', new, made)}"
    assert baseline.changes == ()
    assert [(c.kind, c.path.virtual) for c in first.changes] == [
        (
            FileChangeKind.UPDATE,
            f"/gdocs/owned/{make_filename('Plan', old, FIRST)}",
        ),
        (FileChangeKind.CREATE, notes),
    ]
    assert [(c.kind, c.path.virtual) for c in second.changes] == [
        (
            FileChangeKind.DELETE,
            f"/gdocs/owned/{make_filename('Plan', old, FIRST)}",
        ),
        (
            FileChangeKind.CREATE,
            f"/gdocs/owned/{make_filename('Plan', old, SECOND)}",
        ),
        (FileChangeKind.DELETE, notes),
    ]
