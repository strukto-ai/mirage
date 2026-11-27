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

from mirage.core.gdrive.events import build_delta_hook
from mirage.types import Delta, FileChangeKind, PathSpec
from mirage.utils.key_prefix import mount_key
from tests.fixtures.google_account import FILE, FILES

ROOT = PathSpec(
    vfs_path=mount_key("/drive", "/drive"),
    virtual="/drive",
    directory="/drive",
)
CHANGES = "/drive/v3/changes"
DOC = "application/vnd.google-apps.document"
# Stamped on an item to change it: an item whose modified time is no longer
# its creation time is an update, never a create.
EDITED = "2030-01-01T00:00:00.000Z"
EDITED_AGAIN = "2030-01-02T00:00:00.000Z"


def _kinds(delta: Delta) -> list[tuple[FileChangeKind, str]]:
    return [(c.kind, c.path.virtual) for c in delta.changes]


async def _page_token(google_account) -> str:
    made = await google_account.run.call("GET", f"{CHANGES}/startPageToken")
    return str(made["startPageToken"])


@pytest.mark.asyncio
async def test_changes_are_placed_by_their_parents(google_account):
    docs = await google_account.folder("Docs")
    sub = await google_account.folder("Sub", docs)
    doc = await google_account.create("b", DOC, sub)
    elsewhere = await google_account.folder("Elsewhere")
    stray = await google_account.upload("c.txt", b"c", elsewhere)
    # A My Drive folder takes the shared drive's name in the root listing.
    await google_account.folder("Team")
    drive = await google_account.shared_drive("Team")
    in_drive = await google_account.upload("d.txt", b"d", drive)
    hook = build_delta_hook(google_account.drive_accessor())
    baseline = await hook.pull(ROOT, None)

    await google_account.patch(docs, modifiedTime=EDITED)
    made = await google_account.upload("a.txt", b"a", docs)
    for item in (doc, stray, in_drive):
        await google_account.patch(item, modifiedTime=EDITED)
    # A folder shared with the account rather than kept in its Drive:
    # Drive names no parent for it, so nothing in it is on the mount.
    shared = await google_account.item(elsewhere)
    del shared["parents"]
    await google_account.run.answer_next(
        "GET", FILE, 200, shared, path=f"{FILES}/{elsewhere}"
    )
    first = await hook.pull(ROOT, baseline.checkpoint)

    after_first = await _page_token(google_account)
    await google_account.patch(docs, name="Papers", modifiedTime=EDITED_AGAIN)
    await google_account.patch(made, trashed=True)
    await google_account.delete(
        await google_account.upload("unseen.txt", b"u")
    )
    # The shared drive itself changed: the fake's feed names files only,
    # so its own page is answered with Drive's drive change added.
    page = await google_account.run.call(
        "GET", CHANGES, params={"pageToken": after_first}
    )
    page["changes"].append(
        {"kind": "drive#change", "changeType": "drive", "driveId": drive}
    )
    await google_account.run.answer_next("GET", CHANGES, 200, page)
    second = await hook.pull(ROOT, first.checkpoint)

    assert baseline.changes == ()
    assert _kinds(first) == [
        (FileChangeKind.UPDATE, "/drive/Docs"),
        (FileChangeKind.CREATE, "/drive/Docs/a.txt"),
        (FileChangeKind.UPDATE, "/drive/Docs/Sub/b.gdoc.json"),
        (FileChangeKind.UPDATE, "/drive/Team [Shared Drive]/d.txt"),
    ]
    assert _kinds(second) == [
        (FileChangeKind.DELETE, "/drive/Docs"),
        (FileChangeKind.CREATE, "/drive/Papers"),
        (FileChangeKind.DELETE, "/drive/Docs/a.txt"),
        (FileChangeKind.UNKNOWN, "/drive"),
    ]


@pytest.mark.asyncio
async def test_a_child_listed_before_its_renamed_folder_lands_in_it(
    google_account,
):
    docs = await google_account.folder("Docs")
    hook = build_delta_hook(google_account.drive_accessor())
    baseline = await hook.pull(ROOT, None)
    await google_account.patch(docs, modifiedTime=EDITED)
    first = await hook.pull(ROOT, baseline.checkpoint)
    # The new file is listed before the rename of the folder it is in.
    await google_account.upload("a.txt", b"a", docs)
    await google_account.patch(docs, name="Papers", modifiedTime=EDITED_AGAIN)
    second = await hook.pull(ROOT, first.checkpoint)
    assert _kinds(first) == [(FileChangeKind.UPDATE, "/drive/Docs")]
    assert _kinds(second) == [
        (FileChangeKind.CREATE, "/drive/Papers/a.txt"),
        (FileChangeKind.DELETE, "/drive/Docs"),
        (FileChangeKind.CREATE, "/drive/Papers"),
    ]


@pytest.mark.asyncio
async def test_a_shared_drive_is_named_as_the_root_listing_names_it_now(
    google_account,
):
    # A My Drive folder named like the drive arrives between two reads,
    # and the root listing renames the drive "Team [Shared Drive]".
    drive = await google_account.shared_drive("Team")
    in_drive = await google_account.upload("d.txt", b"d", drive)
    hook = build_delta_hook(google_account.drive_accessor())
    baseline = await hook.pull(ROOT, None)
    await google_account.patch(in_drive, modifiedTime=EDITED)
    first = await hook.pull(ROOT, baseline.checkpoint)
    await google_account.folder("Team")
    await google_account.patch(in_drive, modifiedTime=EDITED_AGAIN)
    second = await hook.pull(ROOT, first.checkpoint)
    assert _kinds(first) == [(FileChangeKind.UPDATE, "/drive/Team/d.txt")]
    assert _kinds(second) == [
        (FileChangeKind.CREATE, "/drive/Team"),
        (FileChangeKind.DELETE, "/drive/Team/d.txt"),
        (FileChangeKind.CREATE, "/drive/Team [Shared Drive]/d.txt"),
    ]


@pytest.mark.asyncio
async def test_a_folder_taking_anothers_name_keeps_its_own_children(
    google_account,
):
    # A renamed to Z and B renamed to A in one read, B's child listed
    # first: the child is in the new A, and stays there for the next read.
    first_folder = await google_account.folder("A")
    second_folder = await google_account.folder("B")
    child = await google_account.upload("c.txt", b"c", second_folder)
    hook = build_delta_hook(google_account.drive_accessor())
    baseline = await hook.pull(ROOT, None)
    for item in (first_folder, second_folder, child):
        await google_account.patch(item, modifiedTime=EDITED)
    first = await hook.pull(ROOT, baseline.checkpoint)
    await google_account.patch(child, modifiedTime=EDITED_AGAIN)
    await google_account.patch(
        first_folder, name="Z", modifiedTime=EDITED_AGAIN
    )
    await google_account.patch(
        second_folder, name="A", modifiedTime=EDITED_AGAIN
    )
    second = await hook.pull(ROOT, first.checkpoint)
    await google_account.patch(child, trashed=True)
    third = await hook.pull(ROOT, second.checkpoint)
    assert _kinds(second) == [
        (FileChangeKind.DELETE, "/drive/B/c.txt"),
        (FileChangeKind.CREATE, "/drive/A/c.txt"),
        (FileChangeKind.DELETE, "/drive/A"),
        (FileChangeKind.CREATE, "/drive/Z"),
        (FileChangeKind.DELETE, "/drive/B"),
        (FileChangeKind.CREATE, "/drive/A"),
    ]
    assert _kinds(third) == [(FileChangeKind.DELETE, "/drive/A/c.txt")]
