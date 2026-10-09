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

import struct
from stat import S_ISCHR

from mirage.runtime.types import VFSEntry, VFSStat
from mirage.runtime.wasm.constants import (
    ALL_RIGHTS,
    FT_CHR,
    FT_DIR,
    FT_REG,
    FT_SYMLINK,
    FT_UNKNOWN,
)


def filetype_of(row: VFSStat | VFSEntry) -> int:
    """The preview1 filetype for one stat or listing row.

    Args:
        row (VFSStat | VFSEntry): the row to classify; a listing row
            with no mode is one the entry point could not classify.
    """
    if row.is_link:
        return FT_SYMLINK
    if row.is_dir:
        return FT_DIR
    if row.mode is None:
        return FT_UNKNOWN
    return FT_CHR if S_ISCHR(row.mode) else FT_REG


def pack_prestat(name_length: int) -> bytes:
    """Encode a prestat record for a preopened directory.

    Args:
        name_length (int): byte length of the preopen's guest path.
    """
    return struct.pack("<II", 0, name_length)


def pack_fdstat(filetype: int) -> bytes:
    """Encode an fdstat record reporting full rights.

    Args:
        filetype (int): preview1 filetype of the descriptor.
    """
    return struct.pack("<BxHxxxxQQ", filetype, 0, ALL_RIGHTS, ALL_RIGHTS)


def pack_filestat(size: int, mtime_ns: int, filetype: int, ino: int) -> bytes:
    """Encode a filestat record.

    A directory links twice, from its parent and from its own ``.``, and
    a file once, as ``st_nlink`` reads on Linux.

    Args:
        size (int): file size in bytes.
        mtime_ns (int): modification time, epoch nanoseconds.
        filetype (int): preview1 filetype.
        ino (int): synthetic inode number, stable within a run.
    """
    return struct.pack(
        "<QQBxxxxxxxQQQQQ",
        0,
        ino,
        filetype,
        2 if filetype == FT_DIR else 1,
        size,
        mtime_ns,
        mtime_ns,
        mtime_ns,
    )
