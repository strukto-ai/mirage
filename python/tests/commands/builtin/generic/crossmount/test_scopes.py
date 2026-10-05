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

from mirage.commands.builtin.generic.crossmount.scopes import (
    mount_starts,
    owned_scopes,
    reached,
)
from mirage.ops.types import MountView, NamespaceView
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import eacces

_DIRS = {"/a": ["/a/d", "/a/f", "/a/m"], "/a/d": ["/a/d/g"], "/a/m": []}
_ROOTS = ["/a", "/a/m"]


def _ns() -> NamespaceView:
    def below(path: str) -> list[str]:
        return [r for r in _ROOTS if r.startswith(path.rstrip("/") + "/")]

    return NamespaceView(
        mounts=MountView(
            descendants=below,
            visible_descendants=below,
            is_root=lambda p: p in _ROOTS,
            root_of=lambda p: "/a/m/" if p.startswith("/a/m") else "/a/",
        )
    )


def _dispatcher(refused: str | None = None):
    listed: list[str] = []

    async def dispatch(op: str, path: PathSpec, **_):
        if path.virtual == refused:
            raise eacces(path)
        if op == "readdir":
            listed.append(path.virtual)
            return _DIRS[path.virtual], None
        kind = FileType.DIRECTORY if path.virtual in _DIRS else FileType.FILE
        return FileStat(name=path.virtual, type=kind), None

    return dispatch, listed


async def _collect(path: str, dispatch, admit=lambda p, s: True):
    return [
        s
        async for s in owned_scopes(
            PathSpec.from_str_path(path), dispatch, _ns(), admit
        )
    ]


@pytest.mark.asyncio
async def test_only_a_directory_holding_a_mount_is_expanded():
    dispatch, listed = _dispatcher()
    scopes = await _collect("/a", dispatch)
    assert [(s.path.virtual, s.walked) for s in scopes] == [
        ("/a/d", True),
        ("/a/f", True),
        ("/a/m", True),
    ]
    assert listed == ["/a"]
    single, _ = _dispatcher()
    assert [s.path.virtual for s in await _collect("/a/d", single)] == ["/a/d"]


@pytest.mark.asyncio
async def test_admit_drops_walked_entries_and_a_refusal_is_its_own_scope():
    dispatch, _ = _dispatcher()
    scopes = await _collect(
        "/a", dispatch, lambda p, s: s.type == FileType.DIRECTORY
    )
    assert [s.path.virtual for s in scopes] == ["/a/d", "/a/m"]
    refusing, _ = _dispatcher(refused="/a/f")
    scopes = await _collect("/a", refusing)
    assert [
        (s.path.virtual, type(s.error).__name__ if s.error else None)
        for s in scopes
    ] == [("/a/d", None), ("/a/f", "PermissionError"), ("/a/m", None)]


def test_mount_starts_are_the_operand_then_each_mount_below_it():
    operand = replace(PathSpec.from_str_path("/a"), raw_path="./a")
    starts = mount_starts(operand, _ns())
    assert starts[0] is operand
    assert [(s.virtual, s.raw_path) for s in starts[1:]] == [("/a/m", "./a/m")]
    refused = replace(operand, walk_error="ENOENT")
    assert mount_starts(refused, _ns()) == [refused]
    assert mount_starts(operand, None) == [operand]


@pytest.mark.asyncio
async def test_a_start_below_a_failed_part_counts_only_where_it_lists():
    paths = [PathSpec.from_str_path("/a"), PathSpec.from_str_path("/a/d")]
    starts = [
        (0, paths[0]),
        (0, PathSpec.from_str_path("/a/m")),
        (0, PathSpec.from_str_path("/a/d/g")),
        (1, paths[1]),
    ]
    dispatch, listed = _dispatcher(refused="/a/d")
    assert await reached(paths, starts, [False] * 4, dispatch) == [True] * 4
    assert listed == []
    failed = [True, False, False, True]
    assert await reached(paths, starts, failed, dispatch) == [
        True,
        True,
        False,
        True,
    ]
    assert listed == ["/a"]
