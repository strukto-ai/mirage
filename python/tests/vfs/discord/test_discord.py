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

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.cache.index import IndexEntry
from mirage.commands.builtin.backends import commands_for
from mirage.types import VFSName
from mirage.utils.abort import MirageAbortError
from mirage.vfs.discord.config import DiscordConfig
from mirage.vfs.discord.discord import DiscordVFS
from mirage.workspace.workspace.workspace import Workspace


@pytest.fixture
def config():
    return DiscordConfig(token="test-bot-token")


def test_vfs_init(config):
    vfs = DiscordVFS(config)
    assert vfs.caches_reads is True


def test_vfs_name(config):
    vfs = DiscordVFS(config)
    assert vfs.name == VFSName.DISCORD


def test_vfs_accessor(config):
    vfs = DiscordVFS(config)
    assert vfs.accessor is not None
    assert vfs.accessor.config is config


def test_vfs_commands(config):
    vfs = DiscordVFS(config)
    # 71 native (the whole generic factory set, whose writers answer
    # ENOTSUP at the op Discord lacks, + bespoke head +
    # md5sum/sha1sum/sha384sum/sha512sum); acting on Discord moved to the
    # discord CLI
    assert len(commands_for(vfs)) == 71


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", [False, True])
async def test_cancel_cat_releases_stalled_attachment(
    config, monkeypatch, prefix
):
    cancel = asyncio.Event()
    stalled = asyncio.Event()

    async def body(size):
        assert size == 16384
        if prefix:
            yield b"first\n"
        stalled.set()
        await asyncio.Event().wait()

    response = MagicMock(status=200)
    response.content.iter_chunked = body
    response.__aenter__ = AsyncMock(return_value=response)
    response.__aexit__ = AsyncMock(return_value=False)
    session = MagicMock()
    session.get.return_value = response
    session.close = AsyncMock()
    monkeypatch.setattr(
        "mirage.core.api.client.resolve_session",
        lambda value: (session, False),
    )
    ws = Workspace({"/chat": DiscordVFS(config)})
    path = (
        "/chat/team__G1/channels/general__C1/2026-04-24/files/report__A1.txt"
    )
    await ws.mount("/chat").index.set_dir(
        path.rsplit("/", 1)[0],
        [
            (
                "report__A1.txt",
                IndexEntry(
                    id="A1",
                    name="report.txt",
                    vfs_name="report__A1.txt",
                    resource_type="discord/attachment",
                    extra={"url": "https://cdn.test/report"},
                ),
            )
        ],
    )
    running = asyncio.create_task(ws.shell(f"cat {path}", cancel=cancel))
    try:
        await asyncio.wait_for(stalled.wait(), 1)
        cancel.set()
        with pytest.raises(MirageAbortError):
            await asyncio.wait_for(running, 1)
        await ws.processes.drain()
        response.__aexit__.assert_awaited_once()
        session.close.assert_not_awaited()
        assert await ws.cache.get(path) is None
    finally:
        cancel.set()
        if not running.done():
            running.cancel()
        await asyncio.gather(running, return_exceptions=True)
        await ws.close()
