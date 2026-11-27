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

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.messages import message_json_bytes
from mirage.core.gmail.stat import stat
from mirage.core.google.client import GoogleApiError
from mirage.types import ContentType, FileStat, FileType, MountMode, PathSpec
from mirage.utils.clock import ManualClock
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gmail import GmailVFS
from mirage.workspace import Workspace
from tests.fixtures.google_account import GMAIL, UNTIL_CLEARED, GoogleAccount
from tests.fixtures.mounted import Mounted
from tests.fixtures.vfs_io import vfs_over

PNG = bytes(range(256)) * 8


@pytest_asyncio.fixture
async def mailbox(google_account: GoogleAccount) -> GoogleAccount:
    """The account with Gmail's system labels and one message in INBOX,
    on 2026-04-12, with a 2048-byte attachment."""
    await google_account.reset()
    await google_account.message(
        "Test Email",
        "hello",
        date="Sun, 12 Apr 2026 12:00:00 +0000",
        attachments=(("image.png", "image/png", PNG),),
    )
    return google_account


@pytest.fixture
def accessor(mailbox: GoogleAccount) -> GmailAccessor:
    return mailbox.gmail_accessor()


async def only_message(account: GoogleAccount) -> dict:
    """The mailbox's one message as Gmail answers a request for it."""
    listed = await account.run.call("GET", f"{GMAIL}/messages")
    return await account.mail(listed["messages"][0]["id"])


async def _stat_at(accessor: GmailAccessor, path: str) -> FileStat:
    return await Mounted(GmailVFS, accessor, "/gmail").stat(path)


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path=mount_key("/", "/gmail"), virtual="/", directory="/"
        ),
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_label(accessor):
    result = await _stat_at(accessor, "/INBOX")
    assert result.type == FileType.DIRECTORY
    assert result.name == "INBOX"
    assert result.extra["label_id"] == "INBOX"


@pytest.mark.asyncio
async def test_stat_date(accessor):
    result = await _stat_at(accessor, "/INBOX/2026-04-12")
    assert result.type == FileType.DIRECTORY
    assert result.name == "2026-04-12"


@pytest.mark.asyncio
async def test_stat_date_outside_the_listed_window(accessor):
    # The label listing is a bounded window of recent messages, so it never
    # minted this day; the date query answers for any well-formed one, so the
    # label's existence is the proof rather than the window.
    result = await _stat_at(accessor, "/INBOX/2020-01-01")
    assert result.type == FileType.DIRECTORY
    assert result.name == "2020-01-01"


@pytest.mark.asyncio
async def test_stat_message(mailbox, accessor):
    raw = await only_message(mailbox)
    name = f"Test_Email__{raw['id']}.gmail.json"
    result = await _stat_at(accessor, f"/INBOX/2026-04-12/{name}")
    assert result.name == name
    assert result.content == ContentType.JSON
    assert result.extra["message_id"] == raw["id"]
    # the listing fetched the message, so the size is the rendered
    # .gmail.json length; the source estimate is surfaced via extra only
    assert result.size == len(message_json_bytes(raw))
    assert result.extra["size_estimate"] == raw["sizeEstimate"]


@pytest.mark.asyncio
async def test_stat_attachment(mailbox, accessor):
    raw = await only_message(mailbox)
    result = await _stat_at(
        accessor, f"/INBOX/2026-04-12/Test_Email__{raw['id']}/image.png"
    )
    assert result.name == "image.png"
    assert result.size == len(PNG)
    part = raw["payload"]["parts"][1]
    assert result.extra["attachment_id"] == part["body"]["attachmentId"]


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await _stat_at(accessor, "/INBOX/nonexistent.gmail.json")


@pytest.mark.asyncio
async def test_stat_unknown_top_level_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await _stat_at(accessor, "/NoSuchLabel")


@pytest.mark.asyncio
async def test_stat_real_label_via_api(mailbox, accessor):
    # A label the mailbox's listing names, not one the mount knows of.
    await mailbox.label("Receipts")
    result = await _stat_at(accessor, "/Receipts")
    assert result.type == FileType.DIRECTORY
    assert result.name == "Receipts"


@pytest.mark.asyncio
async def test_stat_propagates_parent_refresh_failure(mailbox):
    # Gmail refuses the label listing on every retry.
    await mailbox.refuse(
        "GET",
        f"{GMAIL}/labels",
        503,
        "gmail unavailable",
        reason="backendError",
        times=UNTIL_CLEARED,
    )
    # A workspace binds its own clock to its mounts' clients, so the
    # retries wait on the one it is handed.
    vfs = vfs_over(GmailVFS, mailbox.gmail_accessor())
    ws = Workspace(
        {"/gmail/": (vfs, MountMode.READ)},
        mode=MountMode.READ,
        clock=ManualClock(),
    )
    path = PathSpec.from_str_path(
        "/gmail/INBOX/2026-04-12/missing__x1.gmail.json"
    )
    with pytest.raises(GoogleApiError, match="gmail unavailable"):
        await ws.dispatch("stat", path)
