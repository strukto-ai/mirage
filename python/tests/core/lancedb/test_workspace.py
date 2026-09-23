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

import pytest

from mirage.types import MountMode
from mirage.vfs.lancedb import LanceDBVFS
from mirage.workspace import Workspace


@pytest.fixture
def ws(lance_config) -> Workspace:
    return Workspace({"/db/": LanceDBVFS(lance_config)}, mode=MountMode.READ)


async def _out(ws: Workspace, cmd: str) -> str:
    result = await ws.shell(cmd)
    return await result.stdout_str()


@pytest.mark.asyncio
async def test_ls_root_lists_table(ws):
    assert "animals" in await _out(ws, "ls /db/")


@pytest.mark.asyncio
async def test_ls_table_lists_groups(ws):
    out = await _out(ws, "ls /db/animals")
    assert "cat" in out and "dog" in out
    assert "_search" not in out


@pytest.mark.asyncio
async def test_cat_card(ws):
    out = await _out(ws, "cat /db/animals/cat/big/1.md")
    assert "# a big orange cat" in out
    assert "label: cat" in out


@pytest.mark.asyncio
async def test_tree_shows_hierarchy(ws):
    out = await _out(ws, "tree -L 2 /db/animals")
    assert "cat" in out and "dog" in out


@pytest.mark.asyncio
async def test_search_returns_canonical_path_and_card(ws):
    out = await _out(ws, 'search "a small white dog" /db/animals')
    assert "/db/animals/dog/small/4.md" in out
    assert "# a small white dog" in out
    assert "score:" not in out


@pytest.mark.asyncio
async def test_search_result_path_is_readable(ws):
    out = await _out(ws, 'search "a small white dog" /db/animals')
    line = out.splitlines()[0]
    path = line.split(":", 1)[0]
    card = await _out(ws, f"cat {path}")
    assert "# a small white dog" in card


@pytest.mark.asyncio
async def test_grep_recursive_over_cards(ws):
    out = await _out(ws, "grep -rl cat /db/animals")
    assert ".md" in out
