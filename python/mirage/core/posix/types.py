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

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeAlias

# Runs one shell line where the files are: its exit status (None when a
# signal ended it), its output and its error output.
RunFn: TypeAlias = Callable[[str], Awaitable[tuple[int | None, bytes, bytes]]]


@dataclass(frozen=True, slots=True)
class TreeRow:
    """One entry of a ``TREE_FORMAT`` listing, as find printed it.

    Args:
        kind (str): find's type letter (``f``, ``d``, ``l``, ``p``, ...).
        mode (int): the permission bits.
        size (int): the size in bytes.
        mtime (int): the modification time, in whole seconds, as SFTP
            reports it.
        atime (int): the access time, in whole seconds.
        mtime_ms (int): the modification time, in epoch milliseconds.
        atime_ms (int): the access time, in epoch milliseconds.
        uid (int): the owner's uid.
        gid (int): the group's gid.
        nlink (int): the link count.
        blocks (int): the 512-byte blocks it takes.
        rel (str): the path under the listed scope, empty for the scope.
    """

    kind: str
    mode: int
    size: int
    mtime: int
    atime: int
    mtime_ms: int
    atime_ms: int
    uid: int
    gid: int
    nlink: int
    blocks: int
    rel: str
