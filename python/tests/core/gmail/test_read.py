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

import json

import pytest
import pytest_asyncio

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.read import read
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gmail import GmailVFS
from tests.fixtures.google_account import GoogleAccount
from tests.fixtures.mounted import Mounted


@pytest_asyncio.fixture
async def mailbox(google_account: GoogleAccount) -> GoogleAccount:
    """The account with Gmail's system labels and no message yet."""
    await google_account.reset()
    return google_account


@pytest.fixture
def accessor(mailbox: GoogleAccount) -> GmailAccessor:
    return mailbox.gmail_accessor()


def _row(name: str, **extra: str) -> FileStat:
    """A file's row as its folder's listing names it."""
    return FileStat(name=name, type=FileType.FILE, extra=extra)


def _spec(path: str) -> PathSpec:
    """A path under the mount at /gmail.

    Args:
        path (str): the path, mount prefix included.
    """
    return PathSpec(
        vfs_path=mount_key(path, "/gmail"), virtual=path, directory=path
    )


@pytest.mark.asyncio
async def test_read_message(mailbox, accessor):
    msg = await mailbox.message(
        "Test Email", "Hello!", date="Sun, 12 Apr 2026 12:00:00 +0000"
    )
    name = f"Test_Email__{msg}.gmail.json"
    result = await read(
        accessor,
        _spec(f"/gmail/INBOX/2026-04-12/{name}"),
        _row(name, message_id=msg),
    )
    parsed = json.loads(result)
    assert parsed["id"] == msg
    assert parsed["subject"] == "Test Email"


@pytest.mark.asyncio
async def test_read_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await read(accessor, _spec("/gmail/INBOX/nonexistent.gmail.json"))


@pytest.mark.asyncio
async def test_read_is_directory(accessor):
    # A directory kind has no reader, and a matched shape alone is no
    # existence proof, so the kit answers "No such file" (the same rule
    # gcal, notion and the database mounts pin).
    with pytest.raises(FileNotFoundError):
        await read(accessor, _spec("/gmail/INBOX"))


@pytest.mark.asyncio
async def test_a_cold_read_lists_its_way_to_the_message(mailbox, accessor):
    msg = await mailbox.message(
        "Hello World", "hello", date="Mon, 27 Apr 2026 00:00:00 +0000"
    )
    result = await Mounted(GmailVFS, accessor, "/gmail").read(
        f"/INBOX/2026-04-27/Hello_World__{msg}.gmail.json"
    )
    parsed = json.loads(result)
    assert parsed["subject"] == "Hello World"


@pytest.mark.asyncio
async def test_read_attachment(mailbox, accessor):
    msg = await mailbox.message(
        "Meeting",
        "agenda attached",
        date="Sun, 12 Apr 2026 12:00:00 +0000",
        attachments=(("report.pdf", "application/pdf", b"pdf-bytes"),),
    )
    part = (await mailbox.mail(msg))["payload"]["parts"][1]
    path = f"/gmail/INBOX/2026-04-12/Meeting__{msg}/report.pdf"
    result = await read(
        accessor,
        _spec(path),
        _row("report.pdf", attachment_id=part["body"]["attachmentId"]),
    )
    assert result == b"pdf-bytes"
