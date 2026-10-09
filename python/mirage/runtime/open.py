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

import errno
import os
from typing import Protocol

from mirage.errors import FsCondition, classify
from mirage.runtime.handles.mode import OpenMode
from mirage.runtime.types import VFSEntry, VFSStat


class OpenSurface(Protocol):
    """What an open asks of the filesystem it lands on.

    The file adapter answers for the mounts (``RuntimeFiles``, a guest's and
    a ``with ws:`` block's alike), and the wasm router for a guest's
    whole tree, its build directory included (``WasmView``).
    """

    def stat_or_none(
        self, path: str, *, nofollow: bool = False
    ) -> VFSStat | None: ...

    def listing_or_none(self, path: str) -> list[VFSEntry] | None: ...

    def create(self, path: str) -> None: ...

    def truncate(self, path: str) -> None: ...


def apply_open(
    surface: OpenSurface, path: str, mode: OpenMode
) -> VFSStat | None:
    """Apply an open's effect, before any byte moves.

    One rule for every open, however it is spelled (a mode string,
    preview1 oflags): an exclusive create refuses what exists, a
    directory refuses, a missing path is created when the mode creates
    and refused when it does not, and a truncating mode empties what
    exists. The effect lands at open because CPython's ``open('w')``
    leaves an empty file behind even when nothing is written; a bare
    open and close never flushes. Each caller spells the refusals in
    its own dialect (an errno, CPython's wording).

    Args:
        surface (OpenSurface): the filesystem the open lands on.
        path (str): absolute virtual path.
        mode (OpenMode): what the open asked for.

    Returns:
        VFSStat | None: the file's row when its content survives the
        open (a read or an append), None when it starts empty (created
        or truncated).

    Raises:
        FileExistsError: an exclusive create found the path, a dangling
            link or a listed directory included.
        IsADirectoryError: the path is a directory, one a mount lists
            but has no row for included.
        FileNotFoundError: the path is missing and the mode does not
            create.
    """
    # An exclusive create follows no link (POSIX O_CREAT|O_EXCL), so a
    # dangling one is a name that is there. A path with no row may
    # still be a directory the mount lists, and a create there would
    # put a file at a directory's name.
    row = surface.stat_or_none(path, nofollow=mode.exclusive)
    if row is not None:
        listed = row.is_dir
    else:
        listed = surface.listing_or_none(path) is not None
    if mode.exclusive and (row is not None or listed):
        raise _refused(errno.EEXIST, FileExistsError, path)
    if listed:
        raise _refused(errno.EISDIR, IsADirectoryError, path)
    if row is None:
        if not mode.create:
            raise _refused(errno.ENOENT, FileNotFoundError, path)
        surface.create(path)
        return None
    if mode.truncate:
        try:
            surface.truncate(path)
        except Exception as exc:
            if classify(exc) is not FsCondition.ENOTSUP:
                raise
            # A mount with no truncate (hf buckets, databricks volumes)
            # still empties the file through an empty create, which is
            # the effect the open asked for.
            surface.create(path)
        return None
    return row


def _refused(code: int, kind: type[OSError], path: str) -> OSError:
    """An open's refusal, numbered and worded the way the host's own is.

    Args:
        code (int): the errno.
        kind (type[OSError]): the builtin the errno maps to.
        path (str): the path the open named.
    """
    return kind(code, os.strerror(code), path)
