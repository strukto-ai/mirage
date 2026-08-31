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

import aiohttp
import pytest

import mirage.core.discord.read as read_mod
import mirage.core.discord.readdir as readdir_mod
from mirage.accessor.discord import DiscordAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.history import date_to_snowflake
from mirage.core.discord.render import history_jsonl_bytes

GUILD = {"id": "G001", "name": "My Server"}
CHANNELS = [
    {
        "id": "C001",
        "name": "general",
        "type": 0,
        "last_message_id": date_to_snowflake("2024-01-15"),
    },
    {
        "id": "C002",
        "name": "random",
        "type": 0
    },
]
MEMBERS = [{"user": {"id": "U001", "username": "alice"}, "nick": "al"}]

MESSAGES = [
    {
        "id": "1",
        "content": "hello",
        "author": {
            "username": "alice"
        }
    },
    {
        "id":
        "2",
        "content":
        "files",
        "author": {
            "username": "bob"
        },
        "attachments": [
            {
                "id": "A1",
                "filename": "kept.txt",
                "url": "https://cdn.example/kept.txt",
                "size": 5,
                "content_type": "text/plain",
            },
            {
                "id": "A2",
                "filename": "tombstoned.txt",
            },
            {
                "id": "A3",
                "filename": "sizeless.txt",
                "url": "https://cdn.example/sizeless.txt",
            },
            {
                "id": "A4",
                "filename": "urlless.txt",
                "size": 9,
            },
        ],
    },
]

DAY = "2024-01-15"
SEALED_DAY = "2024-01-13"
BROKEN_DAY = "2024-01-12"


def _http_error(status: int) -> aiohttp.ClientResponseError:
    return aiohttp.ClientResponseError(
        request_info=None,  # type: ignore[arg-type]
        history=(),
        status=status)


class FakeDiscordApi:

    def __init__(self) -> None:
        self.day_fetches: list[tuple[str, str]] = []
        self.downloads: list[tuple[str, int, int | None]] = []

    async def list_guilds(self, config, session=None):
        return [dict(GUILD)]

    async def list_channels(self, config, guild_id, session=None):
        assert guild_id == GUILD["id"]
        return [dict(c) for c in CHANNELS]

    async def list_members(self, config, guild_id, session=None):
        assert guild_id == GUILD["id"]
        return [dict(m) for m in MEMBERS]

    async def list_messages_for_day(self,
                                    config,
                                    channel_id,
                                    date_str,
                                    session=None):
        self.day_fetches.append((channel_id, date_str))
        if date_str == SEALED_DAY:
            raise _http_error(403)
        if date_str == BROKEN_DAY:
            raise _http_error(500)
        if channel_id == "C001" and date_str == DAY:
            return [dict(m) for m in MESSAGES]
        return []

    async def get_history_jsonl(self,
                                config,
                                channel_id,
                                date_str,
                                session=None):
        return history_jsonl_bytes(await self.list_messages_for_day(
            config, channel_id, date_str))

    async def download_file(self, url, offset=0, size=None, session=None):
        self.downloads.append((url, offset, size))
        data = b"0123456789"
        end = len(data) if size is None else offset + size
        return data[offset:end]


@pytest.fixture
def api(monkeypatch):
    fake = FakeDiscordApi()
    monkeypatch.setattr(readdir_mod, "list_guilds", fake.list_guilds)
    monkeypatch.setattr(readdir_mod, "list_channels", fake.list_channels)
    monkeypatch.setattr(readdir_mod, "list_members", fake.list_members)
    monkeypatch.setattr(readdir_mod, "list_messages_for_day",
                        fake.list_messages_for_day)
    monkeypatch.setattr(read_mod, "get_history_jsonl", fake.get_history_jsonl)
    monkeypatch.setattr(read_mod, "list_members", fake.list_members)
    monkeypatch.setattr(read_mod, "download_file", fake.download_file)
    return fake


@pytest.fixture
def accessor():
    return DiscordAccessor(config=DiscordConfig(token="test-bot-token"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()
