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

from mirage.accessor.gmail import GmailAccessor
from mirage.core.gmail.messages import message_json_bytes
from mirage.core.gmail.readdir import (
    _date_from_internal,
    _msg_filename,
    _sanitize,
)
from mirage.core.gmail.readdir import readdir as gmail_readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.gmail import GmailVFS
from mirage.vfs.gmail.config import GmailConfig
from tests.fixtures.gmail_api import StubGmail
from tests.fixtures.google_api import offline_token_manager, serve
from tests.fixtures.mounted import mounted


@pytest.fixture
def accessor():
    return GmailAccessor(
        config=GmailConfig(access_token="t"),
        token_manager=offline_token_manager(),
    )


# The label's row, as the mount root's listing names it.
LABEL = FileStat(
    name="INBOX", type=FileType.DIRECTORY, extra={"label_id": "INBOX"}
)


async def readdir(accessor: GmailAccessor, path: PathSpec) -> list[str]:
    return await mounted(GmailVFS, accessor, "/gmail").readdir(path)


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
    with serve(
        gmail=StubGmail(
            list_labels=AsyncMock(
                return_value=[
                    {"id": "INBOX", "type": "system"},
                    {"id": "SENT", "type": "system"},
                ]
            )
        )
    ):
        result = await readdir(
            accessor,
            PathSpec(vfs_path="", virtual="/gmail", directory="/gmail"),
        )
    assert "/gmail/INBOX" in result
    assert "/gmail/SENT" in result


@pytest.mark.asyncio
async def test_readdir_label(accessor):
    with (
        serve(
            gmail=StubGmail(
                list_messages=AsyncMock(return_value=[{"id": "x1"}]),
                get_message_raw=AsyncMock(
                    return_value=_msg_stub("x1", "Hi", 1775952000000)
                ),
            )
        ),
    ):
        listed = await gmail_readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX", "/gmail"),
                virtual="/gmail/INBOX",
                directory="/gmail/INBOX",
            ),
            LABEL,
        )
    result = [f"/gmail/INBOX/{row.name}" for row in listed.entries]
    assert "/gmail/INBOX/2026-04-12" in result


@pytest.mark.asyncio
async def test_readdir_not_found(accessor):
    with serve(
        gmail=StubGmail(
            list_labels=AsyncMock(
                return_value=[{"type": "system", "id": "INBOX"}]
            )
        )
    ):
        with pytest.raises(FileNotFoundError):
            await readdir(
                accessor,
                PathSpec(
                    vfs_path=mount_key("/gmail/NONEXISTENT", "/gmail"),
                    virtual="/gmail/NONEXISTENT",
                    directory="/gmail/NONEXISTENT",
                ),
            )


@pytest.mark.asyncio
async def test_readdir_date_dir_uses_after_before_query(accessor):
    with serve(
        gmail=StubGmail(
            list_labels=AsyncMock(
                return_value=[{"id": "INBOX", "type": "system"}]
            )
        )
    ):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail", "/gmail"),
                virtual="/gmail",
                directory="/gmail",
            ),
        )

    captured_calls: list[dict] = []

    async def fake_list_messages(label_id=None, query=None, max_results=50):
        captured_calls.append(
            {
                "label_id": label_id,
                "query": query,
                "max_results": max_results,
            }
        )
        return []

    with serve(gmail=StubGmail(list_messages=fake_list_messages)):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX/2026-05-03", "/gmail"),
                virtual="/gmail/INBOX/2026-05-03",
                directory="/gmail/INBOX/2026-05-03",
            ),
        )

    assert result == []
    date_calls = [
        c
        for c in captured_calls
        if c["query"] and "after:1777766399" in c["query"]
    ]
    assert len(date_calls) == 1
    assert date_calls[0]["label_id"] == "INBOX"
    assert "before:1777852800" in date_calls[0]["query"]


def _msg_stub(mid, subject, internal_date_ms):
    return {
        "id": mid,
        "internalDate": str(internal_date_ms),
        "payload": {
            "headers": [{"name": "Subject", "value": subject}],
        },
    }


@pytest.mark.asyncio
async def test_readdir_date_dir_returns_msg_files_not_date_strings(accessor):
    target_msgs = [{"id": "x1"}, {"id": "x2"}]
    raws = {
        "x1": _msg_stub("x1", "Hi 27", 1777291200000),
        "x2": _msg_stub("x2", "Bye 27", 1777291200000 + 3600000),
    }

    async def fake_get_message_raw(mid):
        return raws[mid]

    async def fake_list_messages(label_id=None, query=None, max_results=50):
        return target_msgs

    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[{"id": "INBOX", "type": "system"}]
                ),
                list_messages=fake_list_messages,
                get_message_raw=fake_get_message_raw,
            )
        ),
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX/2026-04-27", "/gmail"),
                virtual="/gmail/INBOX/2026-04-27",
                directory="/gmail/INBOX/2026-04-27",
            ),
        )

    assert result == [
        "/gmail/INBOX/2026-04-27/Hi_27__x1.gmail.json",
        "/gmail/INBOX/2026-04-27/Bye_27__x2.gmail.json",
    ]
    for entry in result:
        basename = entry.rsplit("/", 1)[-1]
        assert basename.endswith(".gmail.json"), (
            f"expected .gmail.json file, got: {basename}"
        )


@pytest.mark.asyncio
async def test_readdir_date_dir_warm_cache_matches_cold(accessor):
    target_msgs = [{"id": "x1"}, {"id": "x2"}]
    raws = {
        "x1": _msg_stub("x1", "A", 1777291200000),
        "x2": _msg_stub("x2", "B", 1777291200000 + 3600000),
    }

    async def fake_get_message_raw(mid):
        return raws[mid]

    fetch_count = {"n": 0}

    async def fake_list_messages(label_id=None, query=None, max_results=50):
        fetch_count["n"] += 1
        return target_msgs

    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[{"id": "INBOX", "type": "system"}]
                ),
                list_messages=fake_list_messages,
                get_message_raw=fake_get_message_raw,
            )
        ),
    ):
        cold = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX/2026-04-27", "/gmail"),
                virtual="/gmail/INBOX/2026-04-27",
                directory="/gmail/INBOX/2026-04-27",
            ),
        )
        warm = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX/2026-04-27", "/gmail"),
                virtual="/gmail/INBOX/2026-04-27",
                directory="/gmail/INBOX/2026-04-27",
            ),
        )

    assert warm == cold
    assert fetch_count["n"] == 1, "warm call should not re-fetch"


def _msg_with_attachment(mid, subject, internal_date_ms, att_id, att_filename):
    return {
        "id": mid,
        "internalDate": str(internal_date_ms),
        "payload": {
            "headers": [{"name": "Subject", "value": subject}],
            "parts": [
                {
                    "filename": att_filename,
                    "mimeType": "application/pdf",
                    "body": {
                        "attachmentId": att_id,
                        "size": 1234,
                    },
                }
            ],
        },
    }


@pytest.mark.asyncio
async def test_readdir_date_dir_lists_msg_file_and_attachment_dir(accessor):
    raw = _msg_with_attachment(
        "m1", "Quote", 1777291200000, "att1", "quote.pdf"
    )

    async def fake_get_message_raw(mid):
        return raw

    async def fake_list_messages(label_id=None, query=None, max_results=50):
        return [{"id": "m1"}]

    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[{"id": "INBOX", "type": "system"}]
                ),
                list_messages=fake_list_messages,
                get_message_raw=fake_get_message_raw,
            )
        ),
    ):
        date_listing = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX/2026-04-27", "/gmail"),
                virtual="/gmail/INBOX/2026-04-27",
                directory="/gmail/INBOX/2026-04-27",
            ),
        )
        att_listing = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key(
                    "/gmail/INBOX/2026-04-27/Quote__m1", "/gmail"
                ),
                virtual="/gmail/INBOX/2026-04-27/Quote__m1",
                directory="/gmail/INBOX/2026-04-27/Quote__m1",
            ),
        )

    assert date_listing == [
        "/gmail/INBOX/2026-04-27/Quote__m1.gmail.json",
        "/gmail/INBOX/2026-04-27/Quote__m1",
    ]
    assert att_listing == [
        "/gmail/INBOX/2026-04-27/Quote__m1/quote.pdf",
    ]


@pytest.mark.asyncio
async def test_readdir_date_dir_without_attachments_omits_dir(accessor):
    raw = {
        "id": "m1",
        "internalDate": str(1777291200000),
        "payload": {
            "headers": [{"name": "Subject", "value": "No Attach"}],
        },
    }

    async def fake_get_message_raw(mid):
        return raw

    async def fake_list_messages(label_id=None, query=None, max_results=50):
        return [{"id": "m1"}]

    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[{"id": "INBOX", "type": "system"}]
                ),
                list_messages=fake_list_messages,
                get_message_raw=fake_get_message_raw,
            )
        ),
    ):
        date_listing = await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX/2026-04-27", "/gmail"),
                virtual="/gmail/INBOX/2026-04-27",
                directory="/gmail/INBOX/2026-04-27",
            ),
        )

    assert date_listing == [
        "/gmail/INBOX/2026-04-27/No_Attach__m1.gmail.json",
    ]


@pytest.mark.asyncio
async def test_readdir_message_entry_rendered_size_estimate_in_extra(accessor):
    raw = _msg_stub("m1", "Sized", 1777291200000)
    raw["sizeEstimate"] = 54321

    async def fake_get_message_raw(mid):
        return raw

    async def fake_list_messages(label_id=None, query=None, max_results=50):
        return [{"id": "m1"}]

    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[{"id": "INBOX", "type": "system"}]
                ),
                list_messages=fake_list_messages,
                get_message_raw=fake_get_message_raw,
            )
        ),
    ):
        await readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX/2026-04-27", "/gmail"),
                virtual="/gmail/INBOX/2026-04-27",
                directory="/gmail/INBOX/2026-04-27",
            ),
        )

        row = await mounted(GmailVFS, accessor, "/gmail").stat(
            "/INBOX/2026-04-27/Sized__m1.gmail.json"
        )
    # size is the rendered .gmail.json byte length; sizeEstimate is the
    # source message size and lands in extra, never in size.
    assert row.size == len(message_json_bytes(raw))
    assert row.extra["size_estimate"] == 54321


@pytest.mark.asyncio
async def test_label_glob_pushes_its_span_into_the_query(accessor):
    # The bare listing is the most recent MAX_MESSAGES, so a glob for an
    # older month can only be answered by querying that month.
    captured: list[str | None] = []

    async def fake_list_messages(label_id=None, query=None, max_results=50):
        captured.append(query)
        return []

    with serve(gmail=StubGmail(list_messages=fake_list_messages)):
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
    assert captured == ["after:1767225599 before:1769904000"]


@pytest.mark.asyncio
async def test_a_globbed_label_listing_is_not_the_label(accessor):
    raw = {
        "id": "m1",
        "internalDate": "1767225600000",
        "payload": {"headers": [{"name": "Subject", "value": "Hi"}]},
    }

    async def fake_list_messages(label_id=None, query=None, max_results=50):
        return [{"id": "m1"}] if query else []

    with (
        serve(
            gmail=StubGmail(
                list_messages=fake_list_messages,
                get_message_raw=AsyncMock(return_value=raw),
            )
        ),
    ):
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
        plain = await gmail_readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key("/gmail/INBOX", "/gmail"),
                virtual="/gmail/INBOX",
                directory="/gmail/INBOX",
            ),
            LABEL,
        )
    assert plain.entries == []


DAY = FileStat(
    name="2026-04-27", type=FileType.DIRECTORY, extra={"label_id": "INBOX"}
)


async def _one_message(label_id=None, query=None, max_results=50):
    return [{"id": "x1"}]


@pytest.mark.asyncio
async def test_a_label_and_its_day_are_windows(accessor):
    # Both fetches stop at MAX_MESSAGES, so what they name is a window: a
    # message outside it has not gone anywhere.
    raws = {"x1": _msg_stub("x1", "Hi 27", 1777291200000)}

    async def fake_get_message_raw(mid):
        return raws[mid]

    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[{"id": "INBOX", "type": "system"}]
                ),
                list_messages=_one_message,
                get_message_raw=fake_get_message_raw,
            )
        ),
    ):
        listed = [
            await gmail_readdir(
                accessor,
                PathSpec(
                    vfs_path=mount_key(path, "/gmail"),
                    virtual=path,
                    directory=path,
                ),
                row,
            )
            for path, row in (
                ("/gmail/INBOX", LABEL),
                ("/gmail/INBOX/2026-04-27", DAY),
            )
        ]
    assert [one.window for one in listed] == [True, True]


@pytest.mark.asyncio
async def test_a_day_listed_first_is_a_window(accessor):
    # Listing the day before its label runs the day lister itself, which
    # the seeded path above never reaches.
    raws = {"x1": _msg_stub("x1", "Hi 27", 1777291200000)}

    async def fake_get_message_raw(mid):
        return raws[mid]

    with (
        serve(
            gmail=StubGmail(
                list_labels=AsyncMock(
                    return_value=[{"id": "INBOX", "type": "system"}]
                ),
                list_messages=_one_message,
                get_message_raw=fake_get_message_raw,
            )
        ),
    ):
        path = "/gmail/INBOX/2026-04-27"
        listed = await gmail_readdir(
            accessor,
            PathSpec(
                vfs_path=mount_key(path, "/gmail"),
                virtual=path,
                directory=path,
            ),
            DAY,
        )
    assert listed.window is True
