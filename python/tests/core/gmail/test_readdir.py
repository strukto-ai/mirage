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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.gmail import GmailAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.gmail.readdir import (_date_from_internal, _msg_filename,
                                       _sanitize, readdir)
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.fixture
def accessor():
    return GmailAccessor(config=None, token_manager=None)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


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
async def test_readdir_root(accessor, index):
    await index.set_dir("/gmail", [
        ("INBOX",
         IndexEntry(
             id="INBOX",
             name="INBOX",
             resource_type="gmail/label",
             vfs_name="INBOX",
         )),
        ("SENT",
         IndexEntry(
             id="SENT",
             name="SENT",
             resource_type="gmail/label",
             vfs_name="SENT",
         )),
    ])
    result = await readdir(
        accessor,
        PathSpec(resource_path="", virtual="/gmail", directory="/gmail"),
        index)
    assert "/gmail/INBOX" in result
    assert "/gmail/SENT" in result


@pytest.mark.asyncio
async def test_readdir_label(accessor, index):
    await index.set_dir("/gmail", [
        ("INBOX",
         IndexEntry(
             id="INBOX",
             name="INBOX",
             resource_type="gmail/label",
             vfs_name="INBOX",
         )),
    ])
    await index.set_dir("/gmail/INBOX", [
        ("2026-04-12",
         IndexEntry(
             id="2026-04-12",
             name="2026-04-12",
             resource_type="gmail/date",
             vfs_name="2026-04-12",
         )),
    ])
    result = await readdir(
        accessor,
        PathSpec(resource_path=mount_key("/gmail/INBOX", "/gmail"),
                 virtual="/gmail/INBOX",
                 directory="/gmail/INBOX"), index)
    assert "/gmail/INBOX/2026-04-12" in result


@pytest.mark.asyncio
async def test_readdir_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/NONEXISTENT", "/gmail"),
                     virtual="/gmail/NONEXISTENT",
                     directory="/gmail/NONEXISTENT"), index)


@pytest.mark.asyncio
async def test_readdir_date_dir_uses_after_before_query(accessor, index):
    with patch("mirage.core.gmail.readdir.list_labels",
               new_callable=AsyncMock,
               return_value=[{
                   "id": "INBOX",
                   "type": "system"
               }]):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail", "/gmail"),
                     virtual="/gmail",
                     directory="/gmail"), index)

    captured_calls: list[dict] = []

    async def fake_list_messages(token_manager,
                                 label_id=None,
                                 query=None,
                                 max_results=50):
        captured_calls.append({
            "label_id": label_id,
            "query": query,
            "max_results": max_results,
        })
        return []

    with patch("mirage.core.gmail.readdir.list_messages",
               new=fake_list_messages):
        result = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX/2026-05-03",
                                             "/gmail"),
                     virtual="/gmail/INBOX/2026-05-03",
                     directory="/gmail/INBOX/2026-05-03"), index)

    assert result == []
    date_calls = [
        c for c in captured_calls
        if c["query"] and "after:2026/05/03" in c["query"]
    ]
    assert len(date_calls) == 1
    assert date_calls[0]["label_id"] == "INBOX"
    assert "before:2026/05/04" in date_calls[0]["query"]


def _msg_stub(mid, subject, internal_date_ms):
    return {
        "id": mid,
        "internalDate": str(internal_date_ms),
        "payload": {
            "headers": [{
                "name": "Subject",
                "value": subject
            }],
        },
    }


@pytest.mark.asyncio
async def test_readdir_date_dir_returns_msg_files_not_date_strings(
        accessor, index):
    target_msgs = [{"id": "x1"}, {"id": "x2"}]
    raws = {
        "x1": _msg_stub("x1", "Hi 27", 1777291200000),
        "x2": _msg_stub("x2", "Bye 27", 1777291200000 + 3600000),
    }

    async def fake_get_message_raw(_tm, mid):
        return raws[mid]

    async def fake_list_messages(_tm,
                                 label_id=None,
                                 query=None,
                                 max_results=50):
        return target_msgs

    with (
            patch("mirage.core.gmail.readdir.list_labels",
                  new_callable=AsyncMock,
                  return_value=[{
                      "id": "INBOX",
                      "type": "system"
                  }]),
            patch("mirage.core.gmail.readdir.list_messages",
                  new=fake_list_messages),
            patch("mirage.core.gmail.readdir.get_message_raw",
                  new=fake_get_message_raw),
    ):
        result = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX/2026-04-27",
                                             "/gmail"),
                     virtual="/gmail/INBOX/2026-04-27",
                     directory="/gmail/INBOX/2026-04-27"), index)

    assert result == [
        "/gmail/INBOX/2026-04-27/Hi_27__x1.gmail.json",
        "/gmail/INBOX/2026-04-27/Bye_27__x2.gmail.json",
    ]
    for entry in result:
        basename = entry.rsplit("/", 1)[-1]
        assert basename.endswith(".gmail.json"), (
            f"expected .gmail.json file, got: {basename}")


@pytest.mark.asyncio
async def test_readdir_date_dir_warm_cache_matches_cold(accessor, index):
    target_msgs = [{"id": "x1"}, {"id": "x2"}]
    raws = {
        "x1": _msg_stub("x1", "A", 1777291200000),
        "x2": _msg_stub("x2", "B", 1777291200000 + 3600000),
    }

    async def fake_get_message_raw(_tm, mid):
        return raws[mid]

    fetch_count = {"n": 0}

    async def fake_list_messages(_tm,
                                 label_id=None,
                                 query=None,
                                 max_results=50):
        fetch_count["n"] += 1
        return target_msgs

    with (
            patch("mirage.core.gmail.readdir.list_labels",
                  new_callable=AsyncMock,
                  return_value=[{
                      "id": "INBOX",
                      "type": "system"
                  }]),
            patch("mirage.core.gmail.readdir.list_messages",
                  new=fake_list_messages),
            patch("mirage.core.gmail.readdir.get_message_raw",
                  new=fake_get_message_raw),
    ):
        cold = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX/2026-04-27",
                                             "/gmail"),
                     virtual="/gmail/INBOX/2026-04-27",
                     directory="/gmail/INBOX/2026-04-27"), index)
        warm = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX/2026-04-27",
                                             "/gmail"),
                     virtual="/gmail/INBOX/2026-04-27",
                     directory="/gmail/INBOX/2026-04-27"), index)

    assert warm == cold
    assert fetch_count["n"] == 1, "warm call should not re-fetch"


def _msg_with_attachment(mid, subject, internal_date_ms, att_id, att_filename):
    return {
        "id": mid,
        "internalDate": str(internal_date_ms),
        "payload": {
            "headers": [{
                "name": "Subject",
                "value": subject
            }],
            "parts": [{
                "filename": att_filename,
                "mimeType": "application/pdf",
                "body": {
                    "attachmentId": att_id,
                    "size": 1234,
                },
            }],
        },
    }


@pytest.mark.asyncio
async def test_readdir_date_dir_lists_msg_file_and_attachment_dir(
        accessor, index):
    raw = _msg_with_attachment("m1", "Quote", 1777291200000, "att1",
                               "quote.pdf")

    async def fake_get_message_raw(_tm, mid):
        return raw

    async def fake_list_messages(_tm,
                                 label_id=None,
                                 query=None,
                                 max_results=50):
        return [{"id": "m1"}]

    with (
            patch("mirage.core.gmail.readdir.list_labels",
                  new_callable=AsyncMock,
                  return_value=[{
                      "id": "INBOX",
                      "type": "system"
                  }]),
            patch("mirage.core.gmail.readdir.list_messages",
                  new=fake_list_messages),
            patch("mirage.core.gmail.readdir.get_message_raw",
                  new=fake_get_message_raw),
    ):
        date_listing = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX/2026-04-27",
                                             "/gmail"),
                     virtual="/gmail/INBOX/2026-04-27",
                     directory="/gmail/INBOX/2026-04-27"), index)
        att_listing = await readdir(
            accessor,
            PathSpec(
                resource_path=mount_key("/gmail/INBOX/2026-04-27/Quote__m1",
                                        "/gmail"),
                virtual="/gmail/INBOX/2026-04-27/Quote__m1",
                directory="/gmail/INBOX/2026-04-27/Quote__m1",
            ),
            index,
        )

    assert date_listing == [
        "/gmail/INBOX/2026-04-27/Quote__m1.gmail.json",
        "/gmail/INBOX/2026-04-27/Quote__m1",
    ]
    assert att_listing == [
        "/gmail/INBOX/2026-04-27/Quote__m1/quote.pdf",
    ]


@pytest.mark.asyncio
async def test_readdir_date_dir_without_attachments_omits_dir(accessor, index):
    raw = {
        "id": "m1",
        "internalDate": str(1777291200000),
        "payload": {
            "headers": [{
                "name": "Subject",
                "value": "No Attach"
            }],
        },
    }

    async def fake_get_message_raw(_tm, mid):
        return raw

    async def fake_list_messages(_tm,
                                 label_id=None,
                                 query=None,
                                 max_results=50):
        return [{"id": "m1"}]

    with (
            patch("mirage.core.gmail.readdir.list_labels",
                  new_callable=AsyncMock,
                  return_value=[{
                      "id": "INBOX",
                      "type": "system"
                  }]),
            patch("mirage.core.gmail.readdir.list_messages",
                  new=fake_list_messages),
            patch("mirage.core.gmail.readdir.get_message_raw",
                  new=fake_get_message_raw),
    ):
        date_listing = await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX/2026-04-27",
                                             "/gmail"),
                     virtual="/gmail/INBOX/2026-04-27",
                     directory="/gmail/INBOX/2026-04-27"), index)

    assert date_listing == [
        "/gmail/INBOX/2026-04-27/No_Attach__m1.gmail.json",
    ]


@pytest.mark.asyncio
async def test_readdir_message_entry_size_none_estimate_in_extra(
        accessor, index):
    raw = _msg_stub("m1", "Sized", 1777291200000)
    raw["sizeEstimate"] = 54321

    async def fake_get_message_raw(_tm, mid):
        return raw

    async def fake_list_messages(_tm,
                                 label_id=None,
                                 query=None,
                                 max_results=50):
        return [{"id": "m1"}]

    with (
            patch("mirage.core.gmail.readdir.list_labels",
                  new_callable=AsyncMock,
                  return_value=[{
                      "id": "INBOX",
                      "type": "system"
                  }]),
            patch("mirage.core.gmail.readdir.list_messages",
                  new=fake_list_messages),
            patch("mirage.core.gmail.readdir.get_message_raw",
                  new=fake_get_message_raw),
    ):
        await readdir(
            accessor,
            PathSpec(resource_path=mount_key("/gmail/INBOX/2026-04-27",
                                             "/gmail"),
                     virtual="/gmail/INBOX/2026-04-27",
                     directory="/gmail/INBOX/2026-04-27"), index)

    result = await index.get("/gmail/INBOX/2026-04-27/Sized__m1.gmail.json")
    assert result.entry is not None
    # sizeEstimate is the source message size, not the rendered
    # .gmail.json length: it must land in extra, never in size.
    assert result.entry.size is None
    assert result.entry.extra["size_estimate"] == 54321
