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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.slack.read import read
from mirage.resource.slack.config import SlackConfig
from mirage.types import PathSpec


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
    await index.set_dir("/users", [
        (
            "alice.json",
            IndexEntry(
                id="U001",
                name="alice",
                resource_type="slack/user",
                vfs_name="alice.json",
            ),
        ),
    ])
    return index


@pytest.mark.asyncio
async def test_read_jsonl(accessor, index):
    await _populate_index(index)
    history_bytes = b'{"text":"hello","ts":"1700000001"}\n'
    with patch(
            "mirage.core.slack.read.get_history_jsonl",
            new_callable=AsyncMock,
            return_value=history_bytes,
    ) as mock_hist:
        result = await read(
            accessor,
            PathSpec(
                resource_path=("/channels/general__C001/2023-11-14/chat.jsonl"
                               ).strip("/"),
                virtual="/channels/general__C001/2023-11-14/chat.jsonl",
                directory="/channels/general__C001/2023-11-14/chat.jsonl"),
            index=index)

    assert result == history_bytes
    mock_hist.assert_called_once_with(accessor.config, "C001", "2023-11-14")


@pytest.mark.asyncio
async def test_read_file_blob(accessor, index):
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
    await index.set_dir(
        "/channels/general__C001/2026-04-10/files",
        [
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
        ],
    )
    with patch("mirage.core.slack.files.download_file",
               new_callable=AsyncMock,
               return_value=b"%PDF-1.4 fake bytes"):
        data = await read(
            accessor,
            PathSpec(resource_path=("channels/general__C001/2026-04-10"
                                    "/files/report__F1.pdf"),
                     virtual=("/channels/general__C001/2026-04-10"
                              "/files/report__F1.pdf"),
                     directory=("/channels/general__C001/2026-04-10"
                                "/files/report__F1.pdf")),
            index=index,
        )
    assert data == b"%PDF-1.4 fake bytes"


@pytest.mark.asyncio
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
        result = await read(accessor,
                            PathSpec(resource_path="users/alice.json",
                                     virtual="/users/alice.json",
                                     directory="/users/alice.json"),
                            index=index)

    parsed = json.loads(result)
    assert parsed["id"] == "U001"
    assert parsed["name"] == "alice"


@pytest.mark.asyncio
async def test_read_not_found(accessor, index):
    with pytest.raises(FileNotFoundError):
        await read(accessor,
                   PathSpec(resource_path="nonexistent/path",
                            virtual="/nonexistent/path",
                            directory="/nonexistent/path"),
                   index=index)


@pytest.mark.asyncio
async def test_download_file_uses_bot_token():
    from mirage.core.slack.files import download_file
    seen: list[dict] = []

    class _Resp:

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        def raise_for_status(self):
            return None

        async def read(self):
            return b"OK"

    class _Sess:

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return None

        def get(self, url, headers=None):
            seen.append(headers)
            return _Resp()

    with patch("mirage.core.slack.files.aiohttp.ClientSession", _Sess):
        await download_file(
            SlackConfig(token="xoxb-bot", search_token="xoxp-user"),
            "http://x")
        await download_file(SlackConfig(token="xoxb-bot"), "http://x")
    assert seen[0] == {"Authorization": "Bearer xoxb-bot"}
    assert seen[1] == {"Authorization": "Bearer xoxb-bot"}
