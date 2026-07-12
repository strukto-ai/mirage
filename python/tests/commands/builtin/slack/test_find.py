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
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.slack import COMMANDS
from mirage.resource.slack.config import SlackConfig
from mirage.types import PathSpec

CHANNELS = [
    {
        "id": "C1",
        "name": "general",
        "created": 1
    },
    {
        "id": "C2",
        "name": "random",
        "created": 2
    },
]

GENERAL = "/channels/general__C1"
RANDOM = "/channels/random__C2"


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for slack")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


async def _run(paths, *texts: str, **flags) -> list[str]:
    accessor = SlackAccessor(SlackConfig(token="xoxb-test"))
    find = _find_command()
    with patch("mirage.core.slack.readdir.list_channels",
               new_callable=AsyncMock,
               return_value=CHANNELS):
        stdout, _io = await find(accessor,
                                 paths,
                                 *texts,
                                 index=RAMIndexCacheStore(),
                                 **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_walk_lists_channel_dirs():
    lines = await _run([_spec("/channels")], maxdepth="1")
    assert "/channels" in lines
    assert GENERAL in lines
    assert RANDOM in lines


@pytest.mark.asyncio
async def test_path_pattern_is_honored():
    lines = await _run([_spec("/channels")], maxdepth="1", path="*general*")
    assert lines == [GENERAL]


@pytest.mark.asyncio
async def test_size_is_honored_dirs_count_as_zero():
    lines = await _run([_spec("/channels")], maxdepth="1", size="+0c")
    assert lines == []
    lines = await _run([_spec("/channels")], maxdepth="1", size="-1k")
    assert GENERAL in lines
