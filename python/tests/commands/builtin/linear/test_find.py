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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.linear import COMMANDS
from mirage.resource.linear.config import LinearConfig
from mirage.types import PathSpec

TEAMS = [{
    "id": "TEAM1",
    "key": "ENG",
    "name": "Engineering",
    "updatedAt": "2026-04-05T00:00:00Z",
    "states": {
        "nodes": []
    },
}]

TEAM_DIR = "/teams/ENG__Engineering__TEAM1"


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for linear")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


async def _run(paths, *texts: str, **flags) -> list[str]:
    accessor = LinearAccessor(LinearConfig(api_key="lin_api_test"))
    find = _find_command()
    with patch("mirage.core.linear.readdir.list_teams",
               new_callable=AsyncMock,
               return_value=TEAMS):
        stdout, _io = await find(accessor,
                                 paths,
                                 *texts,
                                 index=RAMIndexCacheStore(),
                                 **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_walk_classifies_dirs_via_stat_without_hint():
    # Linear wires no is_dir_name hint, so the walk stats entries to
    # classify them (stat delegates to the parent readdir listing).
    lines = await _run([_spec("/")], maxdepth="2")
    assert "/teams" in lines
    assert TEAM_DIR in lines


@pytest.mark.asyncio
async def test_maxdepth_three_reaches_static_team_entries():
    lines = await _run([_spec("/")], maxdepth="3", name="team.json")
    assert lines == [f"{TEAM_DIR}/team.json"]


@pytest.mark.asyncio
async def test_type_d_lists_team_subdirs():
    lines = await _run([_spec("/")], maxdepth="3", type="d")
    assert f"{TEAM_DIR}/members" in lines
    assert f"{TEAM_DIR}/issues" in lines
    assert f"{TEAM_DIR}/team.json" not in lines
