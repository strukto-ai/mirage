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
import pytest_asyncio

from mirage.core.gmail import events
from mirage.types import FileChangeKind, PathSpec
from tests.fixtures.google_account import HISTORY, GoogleAccount

pytestmark = pytest.mark.asyncio

ROOT = PathSpec.from_str_path("/gmail", vfs_path="")
JAN_5 = "Mon, 5 Jan 2026 09:00:00 +0000"
JAN_6 = "Tue, 6 Jan 2026 09:00:00 +0000"
JAN_7 = "Wed, 7 Jan 2026 09:00:00 +0000"
JAN_8 = "Thu, 8 Jan 2026 09:00:00 +0000"


@pytest_asyncio.fixture
async def mailbox(google_account: GoogleAccount) -> GoogleAccount:
    """The account with Gmail's system labels and no message yet."""
    await google_account.reset()
    return google_account


def _pairs(delta):
    return [(c.kind, c.path.virtual) for c in delta.changes]


async def test_events_follow_each_message_s_labels(mailbox):
    a1 = await mailbox.message(
        "Budget review",
        "numbers for travel",
        sender="Ana Lima <ana@example.com>",
        date=JAN_5,
        attachments=(("plan.txt", "text/plain", b"plan\n"),),
    )
    # A message no pull names before it goes.
    z9 = await mailbox.message("Gone", "soon", date=JAN_6)
    hook = events.build_delta_hook(mailbox.gmail_accessor())
    baseline = await hook.pull(ROOT, None)
    assert baseline.changes == ()
    await mailbox.trash(a1)
    n3 = await mailbox.message(
        "Hi", "hey", sender="Cy <cy@example.com>", date=JAN_7
    )
    await mailbox.delete_message(z9)
    moved = await hook.pull(ROOT, baseline.checkpoint)
    old, new = "/gmail/INBOX/2026-01-05", "/gmail/TRASH/2026-01-05"
    assert _pairs(moved) == [
        (FileChangeKind.DELETE, f"{old}/Budget_review__{a1}.gmail.json"),
        (FileChangeKind.DELETE, f"{old}/Budget_review__{a1}"),
        (FileChangeKind.CREATE, f"{new}/Budget_review__{a1}.gmail.json"),
        (FileChangeKind.CREATE, f"{new}/Budget_review__{a1}"),
        (
            FileChangeKind.CREATE,
            f"/gmail/INBOX/2026-01-07/Hi__{n3}.gmail.json",
        ),
        (FileChangeKind.UNKNOWN, "/gmail"),
    ]
    # A message a pull has seen leaves the paths it was when it goes.
    await mailbox.delete_message(a1)
    deleted = await hook.pull(ROOT, moved.checkpoint)
    assert _pairs(deleted) == [
        (FileChangeKind.DELETE, f"{new}/Budget_review__{a1}.gmail.json"),
        (FileChangeKind.DELETE, f"{new}/Budget_review__{a1}"),
    ]
    # A history id Gmail no longer keeps reinventories the root, from the
    # one the mailbox is at now.
    await mailbox.message("Later", "after", date=JAN_8)
    await mailbox.refuse(
        "GET",
        HISTORY,
        404,
        "Requested entity was not found.",
        reason="notFound",
    )
    lost = await hook.pull(ROOT, deleted.checkpoint)
    assert _pairs(lost) == [(FileChangeKind.UNKNOWN, "/gmail")]
    now = await mailbox.history_id()
    assert f'"history": "{now}"' in (lost.checkpoint or "")
    assert f'"history": "{now}"' not in (deleted.checkpoint or "")


async def test_events_follow_the_label_folders(mailbox):
    # History records no label created, renamed or deleted: each pull
    # compares the folders, and a message below a renamed one moves with it.
    work = await mailbox.label("Work")
    hook = events.build_delta_hook(mailbox.gmail_accessor())
    baseline = await hook.pull(ROOT, None)
    w1 = await mailbox.message(
        "Plan",
        "go",
        labels=("Work",),
        sender="Di <di@example.com>",
        date=JAN_8,
    )
    seen = await hook.pull(ROOT, baseline.checkpoint)
    plan = f"2026-01-08/Plan__{w1}.gmail.json"
    assert _pairs(seen) == [(FileChangeKind.CREATE, f"/gmail/Work/{plan}")]
    await mailbox.rename_label(work, "Projects")
    empty = await mailbox.label("Empty")
    await mailbox.modify(w1, add=("INBOX",))
    renamed = await hook.pull(ROOT, seen.checkpoint)
    assert _pairs(renamed) == [
        (FileChangeKind.DELETE, "/gmail/Work"),
        (FileChangeKind.CREATE, "/gmail/Projects"),
        (FileChangeKind.CREATE, "/gmail/Empty"),
        (FileChangeKind.CREATE, f"/gmail/INBOX/{plan}"),
        (FileChangeKind.UPDATE, f"/gmail/Projects/{plan}"),
    ]
    # One label takes the name another gives up: each path moves once.
    await mailbox.rename_label(empty, "Archive")
    await mailbox.rename_label(work, "Empty")
    await mailbox.delete_message(w1)
    swapped = await hook.pull(ROOT, renamed.checkpoint)
    assert _pairs(swapped) == [
        (FileChangeKind.DELETE, "/gmail/Projects"),
        (FileChangeKind.DELETE, "/gmail/Empty"),
        (FileChangeKind.CREATE, "/gmail/Empty"),
        (FileChangeKind.CREATE, "/gmail/Archive"),
        (FileChangeKind.DELETE, f"/gmail/Empty/{plan}"),
        (FileChangeKind.DELETE, f"/gmail/INBOX/{plan}"),
    ]
    await mailbox.delete_label(work)
    await mailbox.delete_label(empty)
    removed = await hook.pull(ROOT, swapped.checkpoint)
    assert _pairs(removed) == [
        (FileChangeKind.DELETE, "/gmail/Empty"),
        (FileChangeKind.DELETE, "/gmail/Archive"),
    ]
