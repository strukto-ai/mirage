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

import asyncio
import builtins
import os
from collections.abc import Callable
from typing import IO, TypeAlias, cast

from mirage.ops import Ops
from mirage.ops.file import MirageFile

OpenPath: TypeAlias = (str | bytes | int | os.PathLike[str]
                       | os.PathLike[bytes])
OpenResult: TypeAlias = IO[str] | IO[bytes] | MirageFile


class MountedOpen:

    def __init__(self,
                 ops: Ops,
                 loop: asyncio.AbstractEventLoop | None = None) -> None:
        self._ops = ops
        self._loop = loop
        self._original = builtins.open

    def __call__(
        self,
        file: OpenPath,
        mode: str = "r",
        buffering: int = -1,
        encoding: str | None = None,
        errors: str | None = None,
        newline: str | None = None,
        closefd: bool = True,
        opener: Callable[[str, int], int] | None = None,
    ) -> OpenResult:
        path = os.fspath(file) if isinstance(file, os.PathLike) else file
        if isinstance(path, str) and self._ops.is_mounted(path):
            if not closefd:
                raise ValueError("Cannot use closefd=False with file name")
            if opener is not None:
                raise ValueError("opener is not supported for mounted paths")
            if buffering < -1:
                raise ValueError("invalid buffering size")
            if buffering == 0 and "b" not in mode:
                raise ValueError("can't have unbuffered text I/O")
            return MirageFile(
                self._ops,
                path,
                mode,
                loop=self._loop,
                encoding=encoding,
                errors=errors,
                newline=newline,
            )
        return cast(
            IO[str] | IO[bytes],
            self._original(file, mode, buffering, encoding, errors, newline,
                           closefd, opener))


def make_open(ops: Ops,
              loop: asyncio.AbstractEventLoop | None = None) -> MountedOpen:
    """Create a patched open() that routes mounted paths through ops.

    Args:
        ops (Ops): The ops instance with mount table.
        loop (asyncio.AbstractEventLoop | None): Shared event loop.

    Returns:
        Callable: A patched open function.
    """
    return MountedOpen(ops, loop)
