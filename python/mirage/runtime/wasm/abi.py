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

import errno as host_errno
import struct

# WASI preview1 wire constants. These are NOT the host's POSIX values:
# preview1 numbers its errnos and open flags independently (ENOENT is 44
# on the wire, 2 in Python's errno module), so nothing here can be
# reused from `errno`/`os`.

# errno
OK = 0
EACCES = 2
EBADF = 8
EXDEV = 18
EEXIST = 20
EINVAL = 28
EIO = 29
EISDIR = 31
ENOENT = 44
ENOTDIR = 54
ENOTSUP = 58

# filetypes
FT_UNKNOWN = 0
FT_CHR = 2
FT_DIR = 3
FT_REG = 4

# path_open oflags
OFLAG_CREAT = 1
OFLAG_DIRECTORY = 2
OFLAG_EXCL = 4
OFLAG_TRUNC = 8

# fdflags
FDFLAG_APPEND = 1

# rights
RIGHT_FD_WRITE = 1 << 6
ALL_RIGHTS = 2**64 - 1

# seek whence
WHENCE_SET = 0
WHENCE_CUR = 1
WHENCE_END = 2


def errno_for(exc: BaseException) -> int:
    """Map a host/dispatch exception to its preview1 errno.

    Args:
        exc (BaseException): exception raised by a GuestFs operation.
    """
    if isinstance(exc, FileNotFoundError):
        return ENOENT
    if isinstance(exc, FileExistsError):
        return EEXIST
    if isinstance(exc, IsADirectoryError):
        return EISDIR
    if isinstance(exc, NotADirectoryError):
        return ENOTDIR
    if isinstance(exc, PermissionError):
        return EACCES
    if isinstance(exc, NotImplementedError):
        return ENOTSUP
    if isinstance(exc, OSError):
        if exc.errno == host_errno.EXDEV:
            return EXDEV
        if exc.errno == host_errno.ENOTSUP:
            return ENOTSUP
        return EIO
    return EINVAL


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

    Args:
        size (int): file size in bytes.
        mtime_ns (int): modification time, epoch nanoseconds.
        filetype (int): preview1 filetype.
        ino (int): synthetic inode number, stable within a run.
    """
    return struct.pack("<QQBxxxxxxxQQQQQ", 0, ino, filetype, 1, size, mtime_ns,
                       mtime_ns, mtime_ns)


def pack_dirent(index: int, name: bytes, filetype: int) -> bytes:
    """Encode one fd_readdir entry; d_next/d_ino are the entry index + 1.

    Args:
        index (int): zero-based position of the entry in the listing.
        name (bytes): entry name, already encoded.
        filetype (int): preview1 filetype, FT_UNKNOWN when not known.
    """
    return struct.pack("<QQIBxxx", index + 1, index + 1, len(name),
                       filetype) + name


def unpack_iovs(raw: bytes, count: int) -> list[tuple[int, int]]:
    """Decode an iovec array into (pointer, length) pairs.

    Args:
        raw (bytes): the iovec array bytes read from guest memory.
        count (int): number of iovec records.
    """
    return [struct.unpack_from("<II", raw, i * 8) for i in range(count)]


def pack_u32(value: int) -> bytes:
    return struct.pack("<I", value)


def pack_u64(value: int) -> bytes:
    return struct.pack("<Q", value)
