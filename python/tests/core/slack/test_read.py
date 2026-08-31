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
from unittest.mock import ANY, AsyncMock, patch

import pytest
from aioresponses import aioresponses
from yarl import URL

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.read import read, read_range
from mirage.types import PathSpec

pytestmark = pytest.mark.asyncio

CHANNEL = "channels/general__C001"
CHAT = f"/{CHANNEL}/2023-11-14/chat.jsonl"
BLOB = f"/{CHANNEL}/2026-04-10/files/report__F1.pdf"


def spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.lstrip("/"))


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.fixture
def accessor(config):
    return SlackAccessor(config=config)


@pytest.fixture
def index():
    return RAMIndexCacheStore()


async def _populate_index(index: RAMIndexCacheStore) -> RAMIndexCacheStore:
    await index.set_dir("/channels", [
        (
            "general__C001",
            IndexEntry(
                id="C001",
                name="general",
                resource_type="slack/channel",
                vfs_name="general__C001",
            ),
        ),
    ])
    await index.set_dir(f"/{CHANNEL}/2023-11-14", [
        (
            "chat.jsonl",
            IndexEntry(
                id="C001:2023-11-14:chat",
                name="chat.jsonl",
                resource_type="slack/chat_jsonl",
                vfs_name="chat.jsonl",
                size=35,
            ),
        ),
    ])
    await index.set_dir("/users", [
        (
            "alice__U001.json",
            IndexEntry(
                id="U001",
                name="alice",
                resource_type="slack/user",
                vfs_name="alice__U001.json",
            ),
        ),
    ])
    await index.set_dir(f"/{CHANNEL}/2026-04-10/files", [
        (
            "report__F1.pdf",
            IndexEntry(
                id="F1",
                name="report.pdf",
                resource_type="slack/file",
                vfs_name="report__F1.pdf",
                size=4096,
                extra={
                    "mimetype": "application/pdf",
                    "url_private_download":
                    "https://files.slack.com/x/report.pdf",
                    "channel_id": "C001",
                    "date": "2026-04-10",
                },
            ),
        ),
    ])
    return index


async def test_read_jsonl(accessor, index):
    await _populate_index(index)
    history_bytes = b'{"text":"hello","ts":"1700000001"}\n'
    with patch(
            "mirage.core.slack.read.get_history_jsonl",
            new_callable=AsyncMock,
            return_value=history_bytes,
    ) as mock_hist:
        result = await read(accessor, spec(CHAT), index)

    assert result == history_bytes
    mock_hist.assert_called_once_with(accessor.config,
                                      "C001",
                                      "2023-11-14",
                                      session=ANY)


async def test_read_file_blob(accessor, index):
    await _populate_index(index)
    with patch("mirage.core.slack.files.download_file",
               new_callable=AsyncMock,
               return_value=b"%PDF-1.4 fake bytes"):
        data = await read(accessor, spec(BLOB), index)
    assert data == b"%PDF-1.4 fake bytes"


async def test_read_user_json(accessor, index):
    await _populate_index(index)
    user_data = {
        "id": "U001",
        "name": "alice",
        "real_name": "Alice Smith",
    }
    with patch(
            "mirage.core.slack.read.get_user_profile",
            new_callable=AsyncMock,
            return_value=user_data,
    ):
        result = await read(accessor, spec("/users/alice__U001.json"), index)

    parsed = json.loads(result)
    assert parsed["id"] == "U001"
    assert parsed["name"] == "alice"


async def test_read_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor, spec("/nonexistent/path"), index)


async def test_download_file_uses_bot_token():
    from mirage.core.slack.files import download_file
    with aioresponses() as m:
        m.get("http://x", body=b"OK")
        m.get("http://x", body=b"OK")
        await download_file(
            SlackConfig(token="xoxb-bot", search_token="xoxp-user"),
            "http://x")
        await download_file(SlackConfig(token="xoxb-bot"), "http://x")
        sent = m.requests[("GET", URL("http://x"))]
    assert sent[0].kwargs["headers"] == {"Authorization": "Bearer xoxb-bot"}
    assert sent[1].kwargs["headers"] == {"Authorization": "Bearer xoxb-bot"}


async def test_read_file_blob_pushes_the_window_down(accessor, index):
    await _populate_index(index)
    with patch("mirage.core.slack.files.download_file",
               new_callable=AsyncMock,
               return_value=b"1.4 f") as mock_dl:
        data = await read_range(accessor, spec(BLOB), index, offset=5, size=5)
    assert data == b"1.4 f"
    mock_dl.assert_called_once_with(accessor.config,
                                    "https://files.slack.com/x/report.pdf",
                                    5,
                                    5,
                                    session=ANY)


async def test_read_jsonl_window_is_sliced_locally(accessor, index):
    # Rendered history has no remote range, so the window is taken after.
    await _populate_index(index)
    with patch(
            "mirage.core.slack.read.get_history_jsonl",
            new_callable=AsyncMock,
            return_value=b'{"text":"hello"}\n',
    ):
        result = await read_range(accessor,
                                  spec(CHAT),
                                  index,
                                  offset=1,
                                  size=6)
    assert result == b'"text"'
