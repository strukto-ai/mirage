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

from mirage.commands.builtin.discord.grep import grep
from mirage.commands.builtin.discord.rg import rg
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _path(path: str) -> PathSpec:
    return PathSpec(resource_path=mount_key(path, "/discord"),
                    virtual=path,
                    directory=path)


def _fake_index():
    idx = AsyncMock()

    async def _get(virtual_key):
        result = AsyncMock()
        if virtual_key.endswith("/myguild/channels/general"):
            result.entry = type("E", (), {"id": "C1", "remote_time": ""})
        elif virtual_key.endswith("/myguild"):
            result.entry = type("E", (), {"id": "G1"})
        else:
            result.entry = None
        return result

    idx.get.side_effect = _get
    return idx


@pytest.mark.asyncio
async def test_grep_emits_token_hint_on_forbidden():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [_path("/discord/myguild/channels/general/2026-01-01/chat.jsonl")]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(side_effect=RuntimeError("403 Forbidden")),
    ), patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=paths),
    ), patch(
            "mirage.commands.builtin.discord.grep.discord_read",
            new=AsyncMock(return_value=b""),
    ):
        _out, io = await grep(accessor,
                              paths,
                              "hi",
                              index=_fake_index(),
                              args_l=True)
    stderr = (io.stderr or b"").decode()
    assert "push-down failed" in stderr
    assert "READ_MESSAGE_HISTORY" in stderr


@pytest.mark.asyncio
async def test_rg_emits_warning_on_rate_limit():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [_path("/discord/myguild/channels/general/2026-01-01/chat.jsonl")]
    with patch(
            "mirage.commands.builtin.discord.rg.search_guild",
            new=AsyncMock(side_effect=RuntimeError("rate limited 429")),
    ), patch(
            "mirage.commands.builtin.discord.rg.resolve_glob",
            new=AsyncMock(return_value=paths),
    ), patch(
            "mirage.commands.builtin.discord.rg.generic_rg",
            new=AsyncMock(return_value=(b"", IOResult(exit_code=1))),
    ):
        _out, io = await rg(accessor, paths, "hi", index=_fake_index())
    stderr = (io.stderr or b"").decode()
    assert "push-down failed" in stderr
    # 429 doesn't trigger the perm hint; should still warn
    assert "READ_MESSAGE_HISTORY" not in stderr
