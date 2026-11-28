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
from mirage.core.gmail.readdir import (
    MAX_MESSAGES,
    _date_from_internal,
    _msg_filename,
    _sanitize,
)
from mirage.core.gmail.readdir import readdir as gmail_readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gmail import GmailVFS
from tests.fixtures.google_account import MESSAGES, GoogleAccount
from tests.fixtures.mounted import mounted

# Monday 2026-04-27, at noon UTC and an hour later.
NOON_27 = "Mon, 27 Apr 2026 12:00:00 +0000"
ONE_27 = "Mon, 27 Apr 2026 13:00:00 +0000"


@pytest_asyncio.fixture
async def mailbox(google_account: GoogleAccount) -> GoogleAccount:
    """The account with Gmail's system labels and no message yet, its
    requests recorded once a test has filled it."""
    await google_account.reset()
    return google_account


@pytest.fixture
def accessor(mailbox: GoogleAccount) -> GmailAccessor:
    return mailbox.gmail_accessor()


# The label's row, as the mount root's listing names it.
LABEL = FileStat(
    name="INBOX", type=FileType.DIRECTORY, extra={"label_id": "INBOX"}
)


async def readdir(accessor: GmailAccessor, path: PathSpec) -> list[str]:
    return await mounted(GmailVFS, accessor, "/gmail").readdir(path)


def spec(path: str) -> PathSpec:
    """A path under the mount at /gmail.

    Args:
        path (str): the path, mount prefix included.
    """
    return PathSpec(
        vfs_path=mount_key(path, "/gmail"), virtual=path, directory=path
    )


async def queries(account: GoogleAccount) -> list[dict[str, str]]:
    """The query of each messages listing asked since recording started."""
    return await account.run.params("GET", MESSAGES)


def test_sanitize_normal():
    assert _sanitize("Hello World") == "Hello_World"


def test_sanitize_empty():
    assert _sanitize("") == "No_Subject"
    assert _sanitize("   ") == "No_Subject"


def test_sanitize_special_chars():
    result = _sanitize("Re: [Test] Hello!")
    assert "!" not in result
    assert "[" not in result


def test_sanitize_long():
    long = "A" * 100
    result = _sanitize(long)
    assert len(result) <= 80


def test_msg_filename():
    result = _msg_filename("Test Email", "msg123")
    assert result == "Test_Email__msg123.gmail.json"


def test_date_from_internal():
    assert _date_from_internal("1712966400000") == "2024-04-13"


@pytest.mark.asyncio
async def test_readdir_root(accessor):
    result = await readdir(accessor, spec("/gmail"))
    assert "/gmail/INBOX" in result
    assert "/gmail/SENT" in result


@pytest.mark.asyncio
async def test_readdir_label(mailbox, accessor):
    await mailbox.message(
        "Hi", "hello", date="Sun, 12 Apr 2026 00:00:00 +0000"
    )
    listed = await gmail_readdir(accessor, spec("/gmail/INBOX"), LABEL)
    result = [f"/gmail/INBOX/{row.name}" for row in listed.entries]
    assert "/gmail/INBOX/2026-04-12" in result


@pytest.mark.asyncio
async def test_readdir_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(accessor, spec("/gmail/NONEXISTENT"))


@pytest.mark.asyncio
async def test_readdir_date_dir_uses_after_before_query(mailbox, accessor):
    await readdir(accessor, spec("/gmail"))
    await mailbox.run.record_requests()
    result = await readdir(accessor, spec("/gmail/INBOX/2026-05-03"))
    assert result == []
    date_calls = [
        c
        for c in await queries(mailbox)
        if "after:1777766399" in c.get("q", "")
    ]
    assert len(date_calls) == 1
    assert date_calls[0]["labelIds"] == "INBOX"
    assert "before:1777852800" in date_calls[0]["q"]


@pytest.mark.asyncio
async def test_readdir_date_dir_returns_msg_files_not_date_strings(
    mailbox, accessor
):
    x1 = await mailbox.message("Hi 27", "hello", date=NOON_27)
    x2 = await mailbox.message("Bye 27", "bye", date=ONE_27)
    result = await readdir(accessor, spec("/gmail/INBOX/2026-04-27"))
    # Newest first, as Gmail lists them.
    assert result == [
        f"/gmail/INBOX/2026-04-27/Bye_27__{x2}.gmail.json",
        f"/gmail/INBOX/2026-04-27/Hi_27__{x1}.gmail.json",
    ]
    for entry in result:
        basename = entry.rsplit("/", 1)[-1]
        assert basename.endswith(".gmail.json"), (
            f"expected .gmail.json file, got: {basename}"
        )


@pytest.mark.asyncio
async def test_readdir_date_dir_warm_cache_matches_cold(mailbox, accessor):
    await mailbox.message("A", "a", date=NOON_27)
    await mailbox.message("B", "b", date=ONE_27)
    await mailbox.run.record_requests()
    cold = await readdir(accessor, spec("/gmail/INBOX/2026-04-27"))
    warm = await readdir(accessor, spec("/gmail/INBOX/2026-04-27"))
    assert warm == cold
    assert len(await queries(mailbox)) == 1, "warm call should not re-fetch"


@pytest.mark.asyncio
async def test_readdir_date_dir_lists_msg_file_and_attachment_dir(
    mailbox, accessor
):
    m1 = await mailbox.message(
        "Quote",
        "attached",
        date=NOON_27,
        attachments=(("quote.pdf", "application/pdf", b"%PDF-1.4"),),
    )
    date_listing = await readdir(accessor, spec("/gmail/INBOX/2026-04-27"))
    att_listing = await readdir(
        accessor, spec(f"/gmail/INBOX/2026-04-27/Quote__{m1}")
    )
    assert date_listing == [
        f"/gmail/INBOX/2026-04-27/Quote__{m1}.gmail.json",
        f"/gmail/INBOX/2026-04-27/Quote__{m1}",
    ]
    assert att_listing == [
        f"/gmail/INBOX/2026-04-27/Quote__{m1}/quote.pdf",
    ]


@pytest.mark.asyncio
async def test_readdir_date_dir_without_attachments_omits_dir(
    mailbox, accessor
):
    m1 = await mailbox.message("No Attach", "plain", date=NOON_27)
    date_listing = await readdir(accessor, spec("/gmail/INBOX/2026-04-27"))
    assert date_listing == [
        f"/gmail/INBOX/2026-04-27/No_Attach__{m1}.gmail.json",
    ]


@pytest.mark.asyncio
async def test_readdir_message_entry_rendered_size_estimate_in_extra(
    mailbox, accessor
):
    m1 = await mailbox.message("Sized", "x" * 500, date=NOON_27)
    raw = await mailbox.mail(m1)
    await readdir(accessor, spec("/gmail/INBOX/2026-04-27"))
    row = await mounted(GmailVFS, accessor, "/gmail").stat(
        f"/INBOX/2026-04-27/Sized__{m1}.gmail.json"
    )
    # size is the rendered .gmail.json byte length; sizeEstimate is the
    # source message size and lands in extra, never in size.
    assert row.size == len(message_json_bytes(raw))
    assert row.extra["size_estimate"] == raw["sizeEstimate"]
    assert row.size != raw["sizeEstimate"]


@pytest.mark.asyncio
async def test_label_glob_pushes_its_span_into_the_query(mailbox, accessor):
    # The bare listing is the most recent MAX_MESSAGES, so a glob for an
    # older month can only be answered by querying that month.
    await mailbox.run.record_requests()
    result = await gmail_readdir(
        accessor,
        PathSpec(
            vfs_path=mount_key("/gmail/INBOX/2026-01-*", "/gmail"),
            virtual="/gmail/INBOX/2026-01-*",
            directory="/gmail/INBOX/",
            pattern="2026-01-*",
        ),
        LABEL,
    )
    assert result.entries == []
    assert [c.get("q") for c in await queries(mailbox)] == [
        "after:1767225599 before:1769904000"
    ]


@pytest.mark.asyncio
async def test_a_globbed_label_listing_is_not_the_label(mailbox, accessor):
    # A January message, and a full window of April ones after it.
    await mailbox.message(
        "Hi", "new year", date="Thu, 1 Jan 2026 00:00:00 +0000"
    )
    for n in range(MAX_MESSAGES):
        await mailbox.message(
            f"April {n}", "later", date="Wed, 1 Apr 2026 09:00:00 +0000"
        )
    globbed = await gmail_readdir(
        accessor,
        PathSpec(
            vfs_path=mount_key("/gmail/INBOX/2026-01-*", "/gmail"),
            virtual="/gmail/INBOX/2026-01-*",
            directory="/gmail/INBOX/",
            pattern="2026-01-*",
        ),
        LABEL,
    )
    assert [row.name for row in globbed.entries] == ["2026-01-01"]
    # The glob's answer is no listing of the label, so the unglobbed
    # listing goes back to the recent window rather than January.
    assert globbed.partial is True
    plain = await gmail_readdir(accessor, spec("/gmail/INBOX"), LABEL)
    assert [row.name for row in plain.entries] == ["2026-04-01"]


DAY = FileStat(
    name="2026-04-27", type=FileType.DIRECTORY, extra={"label_id": "INBOX"}
)


@pytest.mark.asyncio
async def test_a_label_and_its_day_are_windows(mailbox, accessor):
    # Both fetches stop at MAX_MESSAGES, so what they name is a window: a
    # message outside it has not gone anywhere.
    await mailbox.message("Hi 27", "hello", date=NOON_27)
    listed = [
        await gmail_readdir(accessor, spec(path), row)
        for path, row in (
            ("/gmail/INBOX", LABEL),
            ("/gmail/INBOX/2026-04-27", DAY),
        )
    ]
    assert [one.window for one in listed] == [True, True]


@pytest.mark.asyncio
async def test_a_day_listed_first_is_a_window(mailbox, accessor):
    # Listing the day before its label runs the day lister itself, which
    # the seeded path above never reaches.
    await mailbox.message("Hi 27", "hello", date=NOON_27)
    path = "/gmail/INBOX/2026-04-27"
    listed = await gmail_readdir(accessor, spec(path), DAY)
    assert listed.window is True
