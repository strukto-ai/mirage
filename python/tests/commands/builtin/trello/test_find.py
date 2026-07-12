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

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.trello import COMMANDS
from mirage.resource.trello.config import TrelloConfig
from mirage.types import PathSpec

WORKSPACES = [{"id": "ws1", "displayName": "Engineering", "name": "eng"}]

WS_DIR = "/workspaces/Engineering__ws1"


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for trello")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


async def _run(paths, *texts: str, **flags) -> list[str]:
    accessor = TrelloAccessor(TrelloConfig(api_key="k", api_token="t"))
    find = _find_command()
    with patch("mirage.core.trello.readdir.list_workspaces",
               new_callable=AsyncMock,
               return_value=WORKSPACES):
        stdout, _io = await find(accessor,
                                 paths,
                                 *texts,
                                 index=RAMIndexCacheStore(),
                                 **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_walk_reaches_workspace_entries():
    lines = await _run([_spec("/")], maxdepth="3")
    assert "/workspaces" in lines
    assert WS_DIR in lines
    assert f"{WS_DIR}/workspace.json" in lines
    assert f"{WS_DIR}/boards" in lines


@pytest.mark.asyncio
async def test_name_and_type_filters():
    files = await _run([_spec("/")], maxdepth="3", name="*.json")
    assert files == [f"{WS_DIR}/workspace.json"]
    dirs = await _run([_spec("/")], maxdepth="3", type="d")
    assert f"{WS_DIR}/boards" in dirs
    assert f"{WS_DIR}/workspace.json" not in dirs
