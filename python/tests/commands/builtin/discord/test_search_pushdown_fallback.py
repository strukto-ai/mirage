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
from dataclasses import replace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from mirage.commands.builtin.discord.grep import grep
from mirage.commands.builtin.discord.io import IO as DISCORD_IO
from mirage.commands.builtin.discord.rg import rg
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.config import CommandOpts
from mirage.core.time_range import TimeRange
from mirage.io.types import IOResult
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _io(
    monkeypatch: pytest.MonkeyPatch, **slots: Callable[..., Any]
) -> CommandIO:
    """Replace backend slots while retaining the checked adapter contract."""
    resolve = slots.pop("resolve_glob", None)
    if resolve is not None:
        monkeypatch.setattr(CommandIO, "resolve_glob", staticmethod(resolve))
    return replace(DISCORD_IO, stat=AsyncMock(), **slots)


def _path(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, "/discord"), virtual=path, directory=path
    )


@pytest.mark.asyncio
async def test_grep_emits_token_hint_on_forbidden(monkeypatch):
    accessor = AsyncMock()
    accessor.time_range = TimeRange()
    accessor.config = AsyncMock()
    paths = [_path("/discord/myguild__G1/channels/general__C1")]
    ops = _io(monkeypatch, resolve_glob=AsyncMock(return_value=paths))
    with patch.dict(
        grep.__globals__,
        {
            "search_guild": AsyncMock(
                side_effect=RuntimeError("403 Forbidden")
            ),
            "grep_generic": AsyncMock(
                return_value=(b"", IOResult(exit_code=1))
            ),
        },
    ):
        _out, io = await grep(
            ops,
            accessor,
            paths,
            ["hi"],
            CommandOpts(flags={"w": True, "r": True}),
        )
    stderr = (io.stderr or b"").decode()
    assert "push-down failed" in stderr
    assert "READ_MESSAGE_HISTORY" in stderr


@pytest.mark.asyncio
async def test_rg_emits_warning_on_rate_limit(monkeypatch):
    accessor = AsyncMock()
    accessor.time_range = TimeRange()
    accessor.config = AsyncMock()
    paths = [_path("/discord/myguild__G1/channels/general__C1")]
    ops = _io(monkeypatch, resolve_glob=AsyncMock(return_value=paths))
    with patch.dict(
        rg.__globals__,
        {
            "search_guild": AsyncMock(
                side_effect=RuntimeError("rate limited 429")
            ),
            "rg_generic": AsyncMock(return_value=(b"", IOResult(exit_code=1))),
        },
    ):
        _out, io = await rg(
            ops,
            accessor,
            paths,
            ["hi"],
            CommandOpts(flags={"word_regexp": True}),
        )
    stderr = (io.stderr or b"").decode()
    assert "push-down failed" in stderr
    # 429 doesn't trigger the perm hint; should still warn
    assert "READ_MESSAGE_HISTORY" not in stderr
