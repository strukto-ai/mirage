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
from mirage.types import PathSpec
from mirage.workspace.mount.namespace.probe import stat_or_none


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

    async def __call__(
        self, op: str, scope: PathSpec, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        self.ops.append(op)
        answer = self.stat if op == "stat" else self.readdir
        if isinstance(answer, Exception):
            raise answer
        return answer, IOResult()


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual, directory=virtual, vfs_path="")


@pytest.mark.asyncio
async def test_stat_or_none_reads_a_chain_through_a_file_as_missing():
    # A folder-id backend answers `f.txt/x` with ENOTDIR from the stat
    # itself, naming the file in the chain; the path is as absent as one
    # a keyed store answers ENOENT for, and mv's own probe words it.
    dispatch = _Dispatch(NotADirectoryError("/data/f.txt"), [])
    assert await stat_or_none(dispatch, _spec("/data/f.txt/x")) is None
    dispatch = _Dispatch(FileNotFoundError("/data/x"), [])
    assert await stat_or_none(dispatch, _spec("/data/x")) is None
    dispatch = _Dispatch(PermissionError("/data/x"), [])
    with pytest.raises(PermissionError):
        await stat_or_none(dispatch, _spec("/data/x"))
