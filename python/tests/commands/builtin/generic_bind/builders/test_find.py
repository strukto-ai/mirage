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

from mirage.commands.builtin.generic_bind.builders.find import find
from mirage.commands.config import CommandIO, Context
from mirage.io.types import materialize
from mirage.types import FileStat, FileType, PathSpec

TREE = {
    "/mnt": ["/mnt/table1", "/mnt/notes.txt"],
    "/mnt/table1": ["/mnt/table1/rows.jsonl"],
}

DIRS = {"/mnt", "/mnt/table1"}


def _ops(stat_calls: list[str], read_tree=None) -> CommandIO:
    async def readdir(_accessor, path, _index):
        return TREE.get(path.virtual.rstrip("/") or "/", [])

    async def stat(_accessor, path, index=None):
        stat_calls.append(path.virtual)
        if (
            path.virtual not in TREE
            and path.virtual not in TREE.get("/mnt", [])
            and path.virtual != "/mnt/table1/rows.jsonl"
        ):
            raise FileNotFoundError(path.virtual)
        if path.virtual in DIRS:
            return FileStat(
                name=path.virtual,
                type=FileType.DIRECTORY,
                modified="2099-01-01T00:00:00+00:00",
            )
        return FileStat(
            type=FileType.FILE,
            name=path.virtual,
            size=3,
            modified="2099-01-01T00:00:00+00:00",
        )

    async def read_stream(_accessor, _path, _index):
        yield b"data"

    async def unused(*_args):
        raise AssertionError("not used")

    return CommandIO(
        readdir=readdir,
        read_bytes=unused,
        read_stream=read_stream,
        stat=stat,
        is_mounted=lambda _a: True,
        read_tree=read_tree,
    )


def _root() -> PathSpec:
    return PathSpec(
        virtual="/mnt", directory="/mnt", resolved=False, vfs_path=""
    )


async def _lines(ops: CommandIO) -> list[str]:
    stdout, _io = await find(ops, None, [_root()], [], Context())
    data = await materialize(stdout)
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_walk_stats_children_to_classify():
    stat_calls: list[str] = []
    ops = _ops(stat_calls)
    lines = await _lines(ops)
    assert "/mnt/notes.txt" in lines
    assert "/mnt/table1/rows.jsonl" in lines
    assert "/mnt/table1" in lines
    # classification comes from stat, an index lookup right after readdir
    assert len(stat_calls) > 1


@pytest.mark.asyncio
async def test_walk_honors_multiple_start_points():
    stat_calls: list[str] = []
    ops = _ops(stat_calls)
    roots = [
        PathSpec(
            virtual="/mnt/table1",
            directory="/mnt/table1",
            resolved=False,
            vfs_path="table1",
        ),
        PathSpec(
            virtual="/mnt/notes.txt",
            directory="/mnt",
            resolved=False,
            vfs_path="notes.txt",
        ),
    ]
    stdout, _io = await find(ops, None, roots, [], Context())
    data = await materialize(stdout)
    lines = data.decode().splitlines()
    # GNU find walks every start point in operand order
    assert "/mnt/table1/rows.jsonl" in lines
    assert "/mnt/notes.txt" in lines
    assert lines.index("/mnt/table1/rows.jsonl") < lines.index(
        "/mnt/notes.txt"
    )


def _tree():
    return {
        "notes.txt": FileStat(
            type=FileType.FILE,
            name="notes.txt",
            size=3,
            modified="2099-01-01T00:00:00+00:00",
        ),
        "table1": FileStat(
            name="table1",
            type=FileType.DIRECTORY,
            modified="2099-01-01T00:00:00+00:00",
        ),
        "table1/rows.jsonl": FileStat(
            type=FileType.FILE,
            name="rows.jsonl",
            size=3,
            modified="2099-01-01T00:00:00+00:00",
        ),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "texts, trees",
    [([], ["/mnt"]), (["-maxdepth", "1"], [])],
    ids=["unbounded", "maxdepth-lists-its-levels"],
)
async def test_find_reads_the_tree_in_one_call(texts, trees):
    asked: list[str] = []

    async def read_tree(_accessor, path, index=None):
        asked.append(path.virtual)
        return _tree()

    async def run(ops: CommandIO) -> list[str]:
        stdout, _io = await find(ops, None, [_root()], texts, Context())
        return (await materialize(stdout)).decode().splitlines()

    assert await run(_ops([], read_tree)) == await run(_ops([]))
    assert asked == trees
