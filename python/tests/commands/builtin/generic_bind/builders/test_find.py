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

from typing import Any

import pytest

from mirage.types import FileStat, FileType, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.answers import Answers, run_generic

TREE = {
    "/mnt": ["/mnt/table1", "/mnt/notes.txt"],
    "/mnt/table1": ["/mnt/table1/rows.jsonl"],
}

DIRS = {"/mnt", "/mnt/table1"}


async def _readdir(path: PathSpec) -> list[str]:
    return TREE.get(path.virtual.rstrip("/") or "/", [])


def _mount(stat_calls: list[str], read_tree: Any = None) -> Answers:
    async def stat(path: PathSpec) -> FileStat:
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

    answers: dict[str, Any] = {"readdir": _readdir, "stat": stat}
    if read_tree is not None:
        answers["read_tree"] = read_tree
    return Answers("/mnt/", **answers)


def _root() -> PathSpec:
    return PathSpec(
        virtual="/mnt", directory="/mnt", resolved=False, vfs_path=""
    )


async def _lines(
    mount: Answers, roots: list[PathSpec], texts: list[str] | None = None
) -> list[str]:
    out, _io = await run_generic("find", mount, roots, texts or [])
    return out.decode().splitlines()


@pytest.mark.asyncio
async def test_walk_stats_children_to_classify():
    stat_calls: list[str] = []
    lines = await _lines(_mount(stat_calls), [_root()])
    assert "/mnt/notes.txt" in lines
    assert "/mnt/table1/rows.jsonl" in lines
    assert "/mnt/table1" in lines
    # classification comes from stat, an index lookup right after readdir
    assert len(stat_calls) > 1


@pytest.mark.asyncio
async def test_walk_honors_multiple_start_points():
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
    lines = await _lines(_mount([]), roots)
    # GNU find walks every start point in operand order
    assert "/mnt/table1/rows.jsonl" in lines
    assert "/mnt/notes.txt" in lines
    assert lines.index("/mnt/table1/rows.jsonl") < lines.index(
        "/mnt/notes.txt"
    )


def _tree() -> dict[str, FileStat]:
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

    async def read_tree(path: PathSpec) -> dict[str, FileStat]:
        asked.append(path.virtual)
        return _tree()

    whole = await _lines(_mount([], read_tree), [_root()], texts)
    assert whole == await _lines(_mount([]), [_root()], texts)
    assert asked == trees


class AskedRAM(RAMVFS):
    """A RAM mount held to two files, with no tree read, noting the limit
    each listing is handed."""

    read_tree = BaseVFS.read_tree

    def __init__(self) -> None:
        super().__init__(walk_limit=2)
        self.asked: list[int | None] = []
        self._store.dirs.add("/d")
        for name in ("a", "b", "c"):
            self._store.files[f"/d/{name}"] = b""

    async def readdir(self, path, limit=None):
        self.asked.append(limit)
        return await super().readdir(path)


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["find /ram/d -maxdepth 1", "tree /ram/d"])
async def test_a_walk_hands_its_listing_the_limit(line):
    vfs = AskedRAM()
    with Workspace({"/ram/": vfs}) as ws:
        await ws.shell(line)
    assert vfs.asked == [3]
