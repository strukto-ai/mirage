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

from mirage.io import IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.workspace.executor.builtins.links import resolve_path_stat


class _Dispatch:
    """Fake op dispatcher answering stat and readdir independently.

    Args:
        stat (FileStat | Exception): what stat returns, or raises.
        readdir (list[str] | Exception): what readdir returns, or raises.
    """

    def __init__(self, stat: Any, readdir: Any) -> None:
        self.stat = stat
        self.readdir = readdir
        self.ops: list[str] = []

    async def __call__(self, op: str, scope: PathSpec,
                       **kwargs: Any) -> tuple[Any, IOResult]:
        self.ops.append(op)
        answer = self.stat if op == "stat" else self.readdir
        if isinstance(answer, Exception):
            raise answer
        return answer, IOResult()


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual, directory=virtual, resource_path="")


@pytest.mark.asyncio
async def test_stat_answers_without_a_listing():
    """A backend whose stat can see the path is asked once."""
    stat = FileStat(name="sub", type=FileType.DIRECTORY)
    dispatch = _Dispatch(stat, AssertionError("readdir must not be reached"))
    assert await resolve_path_stat(dispatch, _spec("/data/sub")) is stat
    assert dispatch.ops == ["stat"]


@pytest.mark.asyncio
async def test_implicit_directory_answers_through_readdir():
    """A directory that exists only as its children still resolves.

    On a prefix store a directory is not an object, so the point lookup
    misses what the listing would show. Measured on every integ target:
    s3, gridfs, hf, nextcloud and the Graph backends all answer here.
    """
    dispatch = _Dispatch(FileNotFoundError("/data/sub"), ["/data/sub/a.txt"])
    stat = await resolve_path_stat(dispatch, _spec("/data/sub"))
    assert stat is not None
    assert stat.type == FileType.DIRECTORY
    assert stat.name == "sub"
    assert dispatch.ops == ["stat", "readdir"]


@pytest.mark.asyncio
async def test_absence_takes_both_channels_coming_back_empty():
    """Nothing there is the only case that resolves to None.

    A prefix store answers a missing path with an empty listing rather
    than raising, so the listing being empty is what separates absence
    from an implicit directory.
    """
    dispatch = _Dispatch(FileNotFoundError("/data/nope"), [])
    assert await resolve_path_stat(dispatch, _spec("/data/nope")) is None


@pytest.mark.asyncio
async def test_a_raising_readdir_is_absence_too():
    """A backend that raises rather than listing empty agrees."""
    dispatch = _Dispatch(FileNotFoundError("/data/nope"),
                         FileNotFoundError("/data/nope"))
    assert await resolve_path_stat(dispatch, _spec("/data/nope")) is None


@pytest.mark.asyncio
async def test_a_permission_error_is_not_absence():
    """Only miss errors resolve to None.

    Mapping a permission or capability failure to "not there" would
    report a path that exists as missing, so it propagates instead.
    """
    dispatch = _Dispatch(PermissionError("/data/locked"), [])
    with pytest.raises(PermissionError):
        await resolve_path_stat(dispatch, _spec("/data/locked"))
