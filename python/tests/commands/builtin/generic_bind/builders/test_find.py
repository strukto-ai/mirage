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

from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.find import find
from mirage.types import FileStat, FileType, PathSpec

TREE = {
    "/mnt": ["/mnt/table1", "/mnt/notes.txt"],
    "/mnt/table1": ["/mnt/table1/rows.jsonl"],
}

DIRS = {"/mnt", "/mnt/table1"}


def _ops(stat_calls: list[str], is_dir_name=None, find_op=None) -> CommandIO:

    async def readdir(_accessor, path, _index):
        return TREE.get(path.virtual.rstrip("/") or "/", [])

    async def stat(_accessor, path, _index):
        stat_calls.append(path.virtual)
        if path.virtual not in TREE and path.virtual not in TREE.get(
                "/mnt", []) and path.virtual != "/mnt/table1/rows.jsonl":
            raise FileNotFoundError(path.virtual)
        if path.virtual in DIRS:
            return FileStat(name=path.virtual, type=FileType.DIRECTORY)
        return FileStat(name=path.virtual, size=3)

    async def read_stream(_accessor, _path, _index):
        yield b"data"

    async def unused(*_args):
        raise AssertionError("not used")

    return CommandIO(readdir=readdir,
                     read_bytes=unused,
                     read_stream=read_stream,
                     stat=stat,
                     is_mounted=lambda _a: True,
                     local=False,
                     is_dir_name=is_dir_name,
                     find=find_op)


def _root() -> PathSpec:
    return PathSpec(virtual="/mnt",
                    directory="/mnt",
                    resolved=False,
                    resource_path="")


async def _lines(ops: CommandIO) -> list[str]:
    stdout, _io = await find(ops, None, [_root()])
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_walk_without_hint_stats_children():
    stat_calls: list[str] = []
    ops = _ops(stat_calls)
    lines = await _lines(ops)
    assert "/mnt/notes.txt" in lines
    assert "/mnt/table1/rows.jsonl" in lines
    assert "/mnt/table1" in lines
    # no hint: every child entry is stat'ed to classify it
    assert len(stat_calls) > 1


@pytest.mark.asyncio
async def test_is_dir_name_hint_skips_child_stats():
    stat_calls: list[str] = []
    ops = _ops(stat_calls,
               is_dir_name=lambda _a, name: name.rstrip("/") in DIRS)
    lines = await _lines(ops)
    assert "/mnt/notes.txt" in lines
    assert "/mnt/table1/rows.jsonl" in lines
    # hint answers directory-ness by name; only the search root is stat'ed
    assert stat_calls == ["/mnt"]


@pytest.mark.asyncio
async def test_walk_honors_multiple_start_points():
    stat_calls: list[str] = []
    ops = _ops(stat_calls)
    roots = [
        PathSpec(virtual="/mnt/table1",
                 directory="/mnt/table1",
                 resolved=False,
                 resource_path="table1"),
        PathSpec(virtual="/mnt/notes.txt",
                 directory="/mnt",
                 resolved=False,
                 resource_path="notes.txt"),
    ]
    stdout, _io = await find(ops, None, roots)
    data = stdout if isinstance(stdout, bytes) else b""
    lines = data.decode().splitlines()
    # GNU find walks every start point in operand order
    assert "/mnt/table1/rows.jsonl" in lines
    assert "/mnt/notes.txt" in lines
    assert lines.index("/mnt/table1/rows.jsonl") < lines.index(
        "/mnt/notes.txt")
