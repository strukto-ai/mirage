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

from mirage.commands.builtin.generic.du import du_generic
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.io import IOResult
from mirage.types import FileStat, FileType, MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@command("du", vfs="ram", spec=SPECS["du"])
async def _measured(accessor, paths, texts, opts):
    async def resolve(targets):
        return targets

    async def stat(path):
        return FileStat(name=path.virtual, type=FileType.DIRECTORY)

    async def entries(path):
        return [("/big", 1000)], 1000

    async def size(path):
        return 1000

    return await du_generic(paths, texts, opts, resolve, stat, size, entries)


@command("du", vfs="ram", spec=SPECS["du"])
async def _unmeasured(accessor, paths, texts, opts):
    return b"777\t" + paths[0].raw_path.encode() + b"\n", IOResult()


async def _workspace(fn) -> Workspace:
    outer, inner, other = RAMVFS(), RAMVFS(), RAMVFS()
    outer.load_state(
        {
            "files": {"/d/f": b"12345", "/n/shadowed": b"y" * 50},
            "dirs": ["/", "/d", "/n"],
        }
    )
    inner.load_state({"files": {"/g": b"123"}})
    other.load_state({"files": {"/h": b"22"}})
    ws = Workspace(
        {"/a": outer, "/a/n": inner, "/b": other}, mode=MountMode.WRITE
    )
    ws.mount("/a/n").register_fns([fn])
    return ws


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        ("du /a", "5\t/a/d\n1000\t/a/n\n1005\t/a\n"),
        ("du -s /a", "1005\t/a\n"),
        ("du -c -d 0 /a /b", "1005\t/a\n2\t/b\n1007\ttotal\n"),
        ("du -a /a/n /b", "1000\t/a/n/big\n1000\t/a/n\n2\t/b/h\n2\t/b\n"),
    ],
)
async def test_each_mount_measures_its_own_part(line, expected):
    ws = await _workspace(_measured)
    try:
        result = await ws.shell(line)
        assert (await result.materialize_stdout()).decode() == expected
        assert result.exit_code == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["du -c /a", "du -c /a/n /b"])
async def test_a_du_without_a_measurement_keeps_the_one_walk(line):
    ws = await _workspace(_unmeasured)
    try:
        result = await ws.shell(line)
        rows = (await result.materialize_stdout()).decode()
        assert "777" not in rows
        assert "3\t/a/n\n" in rows
    finally:
        await ws.close()
