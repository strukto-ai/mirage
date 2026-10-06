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

import dataclasses

import pytest

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.du import WalkBudget, du
from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.ops.types import MountView
from mirage.types import FileStat, FileType, PathSpec

TREE = {
    "/db": ["/db/a.txt", "/db/sub"],
    "/db/sub": ["/db/sub/b.txt"],
}
SIZES = {"/db/a.txt": 3, "/db/sub/b.txt": 2}


def _ops(max_du_entries: int | None = None) -> CommandIO:
    async def readdir(_accessor, path, _index=None):
        return TREE.get(path.virtual.rstrip("/") or "/", [])

    async def stat(_accessor, path, _index=None):
        virtual = path.virtual
        if virtual in TREE:
            return FileStat(name=virtual, type=FileType.DIRECTORY)
        if virtual in SIZES:
            return FileStat(
                type=FileType.FILE, name=virtual, size=SIZES[virtual]
            )
        raise FileNotFoundError(virtual)

    async def read_bytes(_accessor, _path, _index=None):
        return b""

    return CommandIO(
        readdir=readdir,
        read_bytes=read_bytes,
        read_stream=read_bytes,
        stat=stat,
        is_mounted=lambda _a: True,
        max_du_entries=max_du_entries,
    )


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.lstrip("/")
    )


async def _run(ops: CommandIO, path: str, **flags) -> tuple[str, int, str]:
    stream, io = await du(
        ops, object(), [_spec(path)], [], CommandOpts(flags={**flags})
    )
    return (
        (await materialize(stream)).decode(),
        io.exit_code,
        (io.stderr or b"").decode(),
    )


def test_walk_budget_stops_once_spent():
    budget = WalkBudget(2)
    assert [budget.spend("/d") for _ in range(3)] == [True, True, False]
    assert budget.hit is True
    unbounded = WalkBudget(None)
    assert all(unbounded.spend("/d") for _ in range(100))
    assert unbounded.hit is False


def test_walk_budget_with_no_cap_charges_each_mount_its_own():
    caps = {"/a/": None, "/a/b/": 1}
    mounts = MountView(
        descendants=lambda p: [],
        visible_descendants=lambda p: [],
        is_root=lambda p: p.rstrip("/") + "/" in caps,
        root_of=lambda p: "/a/b/" if p.startswith("/a/b") else "/a/",
        max_du_entries=lambda p: caps[
            "/a/b/" if p.startswith("/a/b") else "/a/"
        ],
    )
    budget = WalkBudget(None, mounts=mounts)
    assert all(budget.spend("/a") for _ in range(100))
    assert [budget.spend("/a/b") for _ in range(2)] == [True, False]
    assert budget.hit is True


@pytest.mark.asyncio
async def test_exhausted_budget_reports_partial_output_and_exits_one():
    """A tree bigger than the cap must not report a wrong size silently."""
    out, code, err = await _run(_ops(max_du_entries=1), "/db")
    assert code == 1
    assert "incomplete" in err
    assert out.endswith("\t/db\n")


@pytest.mark.asyncio
async def test_budget_is_shared_across_operands():
    ops = _ops(max_du_entries=1)
    stream, io = await du(
        ops, object(), [_spec("/db"), _spec("/db/sub")], [], CommandOpts()
    )
    assert io.exit_code == 1
    assert len((await materialize(stream)).decode().splitlines()) == 2


_SEALED_TREE = {
    "/db": ["/db/a.txt", "/db/empty", "/db/sealed", "/db/walled"],
    "/db/empty": [],
    "/db/sealed": [],
}


def _sealed_ops() -> CommandIO:
    # /db/sealed lists as refused and /db/walled refuses its stat, the two
    # doors a rule or the host can shut.

    async def readdir(_accessor, path, _index=None):
        if path.virtual == "/db/sealed":
            raise PermissionError(13, "Permission denied", path.virtual)
        return _SEALED_TREE.get(path.virtual, [])

    async def stat(_accessor, path, _index=None):
        if path.virtual == "/db/walled":
            raise PermissionError(13, "Permission denied", path.virtual)
        if path.virtual in _SEALED_TREE:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        if path.virtual == "/db/a.txt":
            return FileStat(name=path.virtual, type=FileType.FILE, size=3)
        raise FileNotFoundError(path.virtual)

    return dataclasses.replace(_ops(), readdir=readdir, stat=stat)


@pytest.mark.asyncio
async def test_a_directory_no_file_points_at_still_gets_its_row():
    # GNU prints a row for an empty directory and for one it cannot open
    # (0 under -ab); a refused stat names the path but proves no directory.
    notes = (
        "du: cannot read directory '/db/sealed': Permission denied\n"
        "du: cannot read directory '/db/walled': Permission denied\n"
    )
    rows = "0\t/db/empty\n0\t/db/sealed\n3\t/db\n"
    assert await _run(_sealed_ops(), "/db") == (rows, 1, notes)
    everything = "3\t/db/a.txt\n" + rows
    assert await _run(_sealed_ops(), "/db", a=True) == (everything, 1, notes)
