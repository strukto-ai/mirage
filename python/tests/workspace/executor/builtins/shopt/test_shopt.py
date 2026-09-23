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
"""shopt: the second option vocabulary, and the glob options it drives.

Set/unset/print/query pinned against bash 5.2.37; ``nullglob``,
``failglob``, ``dotglob`` and ``globstar`` verified through real
expansions, and ``extglob`` refused because the parser has no such mode.
"""
import pytest

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws() -> Workspace:
    return Workspace({"data": RAMVFS()}, mode=MountMode.WRITE)


async def _run(ws: Workspace, cmd: str) -> tuple[str, int]:
    io = await ws.shell(cmd)
    return (await io.stdout_str()), io.exit_code


@pytest.mark.asyncio
async def test_set_unset_and_query():
    ws = _ws()
    _, code = await _run(ws, "shopt -q nullglob")
    assert code == 1
    await _run(ws, "shopt -s nullglob")
    assert await _run(ws, "shopt nullglob") == ("nullglob       \ton\n", 0)
    _, code = await _run(ws, "shopt -q nullglob")
    assert code == 0
    assert await _run(ws, "shopt -p nullglob") == ("shopt -s nullglob\n", 0)
    await ws.close()


@pytest.mark.asyncio
async def test_bad_name_and_conflicting_flags():
    ws = _ws()
    out, code = await _run(ws, "shopt -s bogus")
    assert code == 1
    _, code = await _run(ws, "shopt -su nullglob")
    assert code == 1
    _, code = await _run(ws, "shopt -z")
    assert code == 2
    await ws.close()


@pytest.mark.asyncio
async def test_o_bridges_to_set_options():
    ws = _ws()
    await _run(ws, "shopt -so errexit")
    assert await _run(ws, "shopt -o errexit") == ("errexit        \ton\n", 0)
    _, code = await _run(ws, "shopt -o nullglob")
    assert code == 1
    await ws.close()


@pytest.mark.asyncio
async def test_nullglob_and_failglob():
    ws = _ws()
    out, _ = await _run(ws, "cd /data; echo x*")
    assert out == "x*\n"
    out, _ = await _run(ws, "cd /data; shopt -s nullglob; echo pre x* post")
    assert out == "pre post\n"
    out, code = await _run(ws, "cd /data; shopt -s failglob; echo x*")
    assert code != 0
    await ws.close()


@pytest.mark.asyncio
async def test_dotglob():
    ws = _ws()
    await _run(ws, "touch /data/.h /data/f.txt")
    out, _ = await _run(ws, "echo /data/*")
    assert out == "/data/f.txt\n"
    out, _ = await _run(ws, "shopt -s dotglob; echo /data/*")
    assert out == "/data/.h /data/f.txt\n"
    await ws.close()


@pytest.mark.asyncio
async def test_globstar():
    ws = _ws()
    await _run(
        ws, "mkdir -p /data/d/e; touch /data/f.txt /data/d/g.txt "
        "/data/d/e/h.txt")
    out, _ = await _run(ws, "shopt -s globstar; echo /data/**/*.txt")
    assert out == "/data/d/e/h.txt /data/d/g.txt /data/f.txt\n"
    out, _ = await _run(ws, "shopt -s globstar; echo /data/d/**")
    assert out == "/data/d/ /data/d/e /data/d/e/h.txt /data/d/g.txt\n"
    await ws.close()


@pytest.mark.asyncio
async def test_extglob_is_refused():
    ws = _ws()
    _, code = await _run(ws, "shopt -s extglob")
    assert code == 1
    # Querying an off option exits 1, as bash does.
    assert await _run(ws, "shopt extglob") == ("extglob        \toff\n", 1)
    await ws.close()
