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

from dataclasses import replace

import pytest

from mirage.commands.builtin.generic.crossmount.find import (
    joints,
    predicates,
    shifted,
)
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.errors.fs import eacces
from mirage.io import IOResult
from mirage.ops.registry import op
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _rows_from_its_own_find(rows: bool = True):
    @command("find", vfs="ram", spec=SPECS["find"])
    async def find(accessor, paths, texts, opts):
        found = [
            replace(
                PathSpec.from_str_path(p.virtual + "/own"),
                raw_path=p.raw_path + "/own",
            )
            for p in paths
        ]
        body = "".join(f"{row.raw_path}\n" for row in found).encode()
        return body, IOResult(matched_runs=[found] if rows else None)

    return find


@command("find", vfs="ram", spec=SPECS["find"])
async def _refused(accessor, paths, texts, opts):
    raise eacces(paths[0])


@op("readdir", vfs="ram")
async def _unlisted(accessor, path, **kwargs):
    raise eacces(path)


async def _workspace(*fns) -> Workspace:
    outer, inner = RAMVFS(), RAMVFS()
    outer.load_state(
        {
            "files": {"/d/f": b"x", "/n/shadowed": b"y"},
            "dirs": ["/", "/d", "/n"],
        }
    )
    inner.load_state({"files": {"/g": b"z"}})
    ws = Workspace({"/a": outer, "/a/n": inner}, mode=MountMode.WRITE)
    ws.mount("/a/n").register_fns(list(fns))
    return ws


def test_predicates_skip_the_words_a_predicate_takes():
    words = ["-name", "-prune", "-exec", "echo", "-empty", ";", "-print"]
    assert predicates(words) == [(0, "-name"), (2, "-exec"), (6, "-print")]


def test_shifted_counts_the_limits_from_the_start_point():
    words = ["-maxdepth", "3", "-mindepth", "2", "-name", "x"]
    flags = {"maxdepth": "3", "mindepth": "2", "name": "x"}
    assert shifted(words, flags, 2, 3, 2) == (
        ["-maxdepth", "1", "-mindepth", "0", "-name", "x"],
        {"maxdepth": "1", "mindepth": "0", "name": "x"},
    )
    assert shifted(words, flags, 4, 3, 2) is None
    assert shifted(words, flags, 1, 3, 2, alone=True) is None
    assert shifted(["-type", "d"], {"type": "d"}, 1, None, None, True) == (
        ["-maxdepth", "0", "-type", "d"],
        {"type": "d", "maxdepth": "0"},
    )


def test_joints_are_the_directories_between_the_operand_and_its_mounts():
    root = PathSpec.from_str_path("/")
    starts = [root] + [
        PathSpec.from_str_path(p) for p in ("/usr/bin", "/a/b/c", "/a/b")
    ]
    assert [j.virtual for j in joints(root, starts)] == ["/a", "/usr"]


@pytest.mark.asyncio
async def test_each_mount_answers_for_its_own_part():
    ws = await _workspace(_rows_from_its_own_find())
    try:
        result = await ws.shell("find /a")
        assert await result.materialize_stdout() == (
            b"/a\n/a/d\n/a/d/f\n/a/n/own\n"
        )
        result = await ws.shell("find / -maxdepth 1 -name usr")
        assert await result.materialize_stdout() == b"/usr\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["find /a -name x -prune -o -print", "find -L /a -type f"]
)
async def test_an_expression_across_mounts_keeps_the_one_walk(line):
    ws = await _workspace(_rows_from_its_own_find())
    try:
        result = await ws.shell(line)
        rows = await result.materialize_stdout()
        assert b"/a/n/g" in rows
        assert b"own" not in rows
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_find_without_rows_keeps_the_one_walk():
    ws = await _workspace(_rows_from_its_own_find(rows=False))
    try:
        result = await ws.shell("find /a -type f")
        assert await result.materialize_stdout() == b"/a/d/f\n/a/n/g\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fns,expected",
    [([_refused], b"/a/n/own\n"), ([_refused, _unlisted], b"")],
)
async def test_a_mount_below_a_failed_part_counts_where_the_walk_reaches(
    fns, expected
):
    ws = await _workspace(_rows_from_its_own_find())
    ws.mount("/a").register_fns(fns)
    try:
        result = await ws.shell("find /a")
        assert await result.materialize_stdout() == expected
        assert result.exit_code == 1
    finally:
        await ws.close()
