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

from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import RAMIndexCacheStore
from mirage.commands.builtin.slack.grep import grep
from mirage.commands.builtin.slack.rg import rg
from mirage.commands.config import CommandOpts
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.read import read as core_read
from mirage.core.slack.readdir import readdir as core_readdir
from mirage.core.slack.stat import stat as core_stat
from mirage.io.stream import materialize
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.slack import SlackVFS
from tests.fixtures.vfs_io import io_for


def _io(**slots: Callable[..., Any]) -> SimpleNamespace:
    """The command's IO with the given slots faked; the rest stay real."""
    real = {
        "readdir": core_readdir,
        "stat": core_stat,
        "read_bytes": core_read,
    }
    return SimpleNamespace(**{**real, **slots})


@pytest.fixture
def accessor():
    return SlackAccessor(config=SlackConfig(token="xoxb", search_token="xoxp"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_rg_chat_jsonl_scans_the_named_day(accessor, index):
    # One day's chat.jsonl used to be widened to a channel-wide search
    # (`coalesce_scopes`), which answered with every day the channel ever
    # had. It is one file: read it and grep it.
    mock_msgs = AsyncMock()
    mock_files = AsyncMock()
    mock_generic = AsyncMock(return_value=(b"", None))
    with patch.dict(
        rg.__wrapped__.__globals__,
        {
            "search_messages": mock_msgs,
            "search_files": mock_files,
            "rg_generic": mock_generic,
        },
    ):
        await rg(
            accessor,
            [
                PathSpec(
                    vfs_path=mount_key(
                        "/channels/general__C001/2026-04-10/chat.jsonl", ""
                    ),
                    virtual="/channels/general__C001/2026-04-10/chat.jsonl",
                    directory="/channels/general__C001/2026-04-10/chat.jsonl",
                )
            ],
            ["foo"],
            CommandOpts(
                io=_io(resolve_glob=AsyncMock(return_value=[])),
                index=index,
                flags={"word_regexp": True},
            ),
        )
    assert mock_msgs.await_count == 0
    assert mock_files.await_count == 0
    assert mock_generic.await_count == 1


@pytest.mark.asyncio
async def test_rg_files_dir_redirects_to_generic_scan(accessor, index):
    mock_msgs = AsyncMock()
    mock_files = AsyncMock()
    mock_generic = AsyncMock(return_value=(b"", None))
    with patch.dict(
        rg.__wrapped__.__globals__,
        {
            "search_messages": mock_msgs,
            "search_files": mock_files,
            "rg_generic": mock_generic,
        },
    ):
        await rg(
            accessor,
            [
                PathSpec(
                    vfs_path=mount_key(
                        "/channels/general__C001/2026-04-10/files", ""
                    ),
                    virtual="/channels/general__C001/2026-04-10/files",
                    directory="/channels/general__C001/2026-04-10/files",
                )
            ],
            ["foo"],
            CommandOpts(
                io=io_for(SlackVFS, accessor),
                index=index,
                flags={"word_regexp": True},
            ),
        )
    assert mock_msgs.await_count == 0
    assert mock_files.await_count == 0
    assert mock_generic.await_count == 1


@pytest.mark.asyncio
async def test_grep_chat_jsonl_scans_the_named_day(accessor, index):
    mock_msgs = AsyncMock()
    mock_files = AsyncMock()
    mock_generic = AsyncMock(return_value=(b"", None))
    with patch.dict(
        grep.__wrapped__.__globals__,
        {
            "search_messages": mock_msgs,
            "search_files": mock_files,
            "grep_generic": mock_generic,
        },
    ):
        await grep(
            accessor,
            [
                PathSpec(
                    vfs_path=mount_key(
                        "/channels/general__C001/2026-04-10/chat.jsonl", ""
                    ),
                    virtual="/channels/general__C001/2026-04-10/chat.jsonl",
                    directory="/channels/general__C001/2026-04-10/chat.jsonl",
                )
            ],
            ["foo"],
            CommandOpts(
                io=_io(resolve_glob=AsyncMock(return_value=[])),
                index=index,
                flags={"w": True},
            ),
        )
    assert mock_msgs.await_count == 0
    assert mock_files.await_count == 0
    assert mock_generic.await_count == 1
    assert mock_files.await_count == 0


@pytest.mark.asyncio
async def test_grep_files_dir_redirects_to_per_file_scan(accessor, index):
    blob = PathSpec(
        vfs_path=mount_key(
            "/channels/general__C001/2026-04-10/files/report.txt", ""
        ),
        virtual="/channels/general__C001/2026-04-10/files/report.txt",
        directory="/channels/general__C001/2026-04-10/files/report.txt",
    )
    mock_read = AsyncMock(return_value=b"foo line\nbar\n")
    mock_msgs = AsyncMock()
    mock_files = AsyncMock()
    with patch.dict(
        grep.__wrapped__.__globals__,
        {
            "search_messages": mock_msgs,
            "search_files": mock_files,
        },
    ):
        out, io = await grep(
            accessor,
            [
                PathSpec(
                    vfs_path=mount_key(
                        "/channels/general__C001/2026-04-10/files", ""
                    ),
                    virtual="/channels/general__C001/2026-04-10/files",
                    directory="/channels/general__C001/2026-04-10/files",
                )
            ],
            ["foo"],
            CommandOpts(
                io=_io(
                    resolve_glob=AsyncMock(return_value=[blob]),
                    read_bytes=mock_read,
                    stat=AsyncMock(
                        return_value=FileStat(
                            name="report.txt",
                            type=FileType.FILE,
                            content=ContentType.TEXT,
                        )
                    ),
                ),
                index=index,
                flags={"w": True},
            ),
        )
    assert mock_msgs.await_count == 0
    assert mock_files.await_count == 0
    assert mock_read.await_count >= 1
    assert b"foo line" in await materialize(out)
