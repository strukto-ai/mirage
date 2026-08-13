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

from mirage.errors import FsCondition, classify

# WASI preview1 wire numbers, from wasi-libc's errno.h (alphabetical
# numbering). These are NOT the host's POSIX values and must never be
# collapsed with them: ENOENT is 44 on the wire and 2 in Python's errno
# module, and 18 here is EDOM where the host's 18 is EXDEV. The table
# is total over the vocabulary; test_abi.py fails a half-added member.
WASI: dict[FsCondition, int] = {
    FsCondition.ENOENT:
    44,
    FsCondition.ENOTDIR:
    54,
    FsCondition.EISDIR:
    31,
    FsCondition.EEXIST:
    20,
    FsCondition.EACCES:
    2,
    FsCondition.EPERM:
    63,
    FsCondition.ENOTEMPTY:
    55,
    FsCondition.EXDEV:
    75,
    # Each mount is its own preopen to a WASI guest, so a rename between
    # two of them reads as a destination that is not there. pathlib's
    # EXDEV is the monty dialect's answer, not this wire's; the row IS
    # that decision (finding 8).
    FsCondition.CROSS_MOUNT:
    44,
    FsCondition.ENOTSUP:
    58,
    FsCondition.ELOOP:
    32,
    FsCondition.EINVAL:
    28,
    FsCondition.EIO:
    29,
    FsCondition.EBUSY:
    10,
    FsCondition.EROFS:
    69,
    # preview1 has no xattr syscalls, so this row is unreachable from a
    # guest; ENOTSUP is the honest answer if a future host ever asks.
    FsCondition.NO_XATTR:
    58,
}


def wasi_errno(condition: FsCondition) -> int:
    """The preview1 wire number for a condition.

    Args:
        condition (FsCondition): the named condition.
    """
    return WASI[condition]


# errno. EBADF stays a local literal because a bad guest fd is the fd
# table's condition, never a mount's, so the vocabulary does not name
# it.
OK = 0
EACCES = wasi_errno(FsCondition.EACCES)
EBADF = 8
EXDEV = wasi_errno(FsCondition.EXDEV)
EEXIST = wasi_errno(FsCondition.EEXIST)
EINVAL = wasi_errno(FsCondition.EINVAL)
EIO = wasi_errno(FsCondition.EIO)
EISDIR = wasi_errno(FsCondition.EISDIR)
ENOENT = wasi_errno(FsCondition.ENOENT)
ENOTDIR = wasi_errno(FsCondition.ENOTDIR)
ENOTSUP = wasi_errno(FsCondition.ENOTSUP)

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

    The naming lives in ``mirage.errors.classify`` and the numbering in
    the ``WASI`` table above, where the cross-mount-rename-is-ENOENT
    decision also lives. An OSError the vocabulary does not name
    degrades to EIO and anything else to EINVAL, matching the arms this
    function carried by hand.

    Args:
        exc (BaseException): exception raised by a WasmVFS operation.
    """
    condition = classify(exc)
    if condition is not None:
        return wasi_errno(condition)
    if isinstance(exc, OSError):
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
