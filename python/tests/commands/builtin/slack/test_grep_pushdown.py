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

from mirage.accessor.slack import SlackAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.slack.grep import grep
from mirage.commands.builtin.slack.io import IO as BACKEND_IO
from mirage.commands.config import CommandOpts
from mirage.core.slack.config import SlackConfig
from mirage.core.time_range import TimeRange
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_grep_on_a_time_scoped_mount_skips_native_search():
    """Slack search cannot honor the mount's time bounds, so a scoped
    mount answers from the scan, where a bare directory is GNU's EISDIR."""
    accessor = SlackAccessor(
        SlackConfig(token="xoxb-test"),
        TimeRange.from_strings("2026-01-01T00:00:00Z", None),
    )
    index = RAMIndexCacheStore()
    await index.set_dir(
        "/slack/channels",
        [
            (
                "general__C1",
                IndexEntry(
                    id="C1",
                    name="general",
                    resource_type="slack/channel",
                    vfs_name="general__C1",
                ),
            )
        ],
    )
    channel = [
        PathSpec(
            vfs_path=mount_key("/slack/channels/general__C1", "/slack"),
            virtual="/slack/channels/general__C1",
            directory="/slack/channels/general__C1",
        )
    ]
    with patch(
        "mirage.commands.builtin.slack.grep.search_messages",
        new=AsyncMock(return_value=b"{}"),
    ) as fake_search:
        _out, io = await grep(
            BACKEND_IO,
            accessor,
            channel,
            ["hello"],
            CommandOpts(index=index, flags={"w": True}),
        )
    fake_search.assert_not_awaited()
    assert io.exit_code == 2
    assert b"Is a directory" in io.stderr
