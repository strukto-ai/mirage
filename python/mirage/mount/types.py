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

from dataclasses import dataclass, field

from mirage.runtime.handles import ChunkedHandle
from mirage.runtime.handles.mode import READ, OpenMode
from mirage.types import FileStat

WriteBuf = list[tuple[int, bytearray]]


@dataclass(frozen=True, slots=True)
class MountAttrs:
    """One entry's POSIX attributes, as every adapter over the core needs
    them.

    Neutral rather than libfuse's ``st_*`` dict: SFTP and codex-exec read
    the fields, and the libfuse adapter spells them as ``st_*``.

    Args:
        mode (int): type bits plus permissions.
        size (int): byte length the client should see.
        nlink (int): link count; 2 for a directory, 1 otherwise.
        uid (int): owning user id.
        gid (int): owning group id.
        rdev (int): device number, for a device node.
        atime (int): access time, nanoseconds since the epoch.
        mtime (int): modification time, nanoseconds since the epoch.
        ctime (int): change time, nanoseconds since the epoch.
    """

    mode: int
    size: int
    nlink: int
    uid: int
    gid: int
    rdev: int
    atime: int
    mtime: int
    ctime: int


@dataclass(slots=True)
class Handle:
    """One open file, whichever entry point opened it."""

    path: str
    # Where the path really points once namespace links are followed; a
    # file whose name went keys the handles left on it alike.
    key: str
    # What the open asked for: a handle that writes reads the stored
    # bytes, one that appends writes at the end.
    mode: OpenMode = READ
    live: bool = False
    data: bytes | None = None
    write_buf: WriteBuf = field(default_factory=list)
    # A large file reads a chunk at a time rather than hydrating whole.
    chunked: ChunkedHandle | None = None
    # Bumped whenever the file changes, so a first read that was out
    # meanwhile does not keep the bytes it fetched.
    generation: int = 0
    # The file's row as it was when its name was removed or replaced; the
    # open file has no path left. None while it has one.
    detached: FileStat | None = None
    # The stored length the open saw, where an appending handle's writes
    # start while it holds no bytes.
    size: int = 0
    # The file's row as its last stat fetched it and when (monotonic
    # seconds), which a guest's fstat answers by for a moment while
    # nothing changes the file through the core.
    row: FileStat | None = None
    row_at: float = 0.0
    # Bumped whenever the core changes the file's row, so a stat that was
    # out meanwhile does not keep the row it fetched.
    restats: int = 0
    # Why the bytes its file had could not be kept when its name went;
    # every read through it reports it rather than read what the name
    # holds now.
    lost: Exception | None = None
