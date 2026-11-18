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

from stat import S_IFBLK, S_IFCHR, S_IFDIR, S_IFIFO, S_IFLNK, S_IFREG, S_IFSOCK
from typing import Literal

from mirage.types import DEVICE_NUMBERS_KEY, FileStat, FileType
from mirage.utils.dates import iso_timestamp

PrintfKind = Literal["f", "d", "l", "c", "b", "p", "s"]
TYPE_CHARS: dict[FileType, PrintfKind] = {
    FileType.DIRECTORY: "d",
    FileType.SYMLINK: "l",
    FileType.CHAR_DEVICE: "c",
    FileType.BLOCK_DEVICE: "b",
    FileType.FIFO: "p",
    FileType.SOCKET: "s",
}

# The one spelling of "a directory looks like drwxr-xr-x and a file
# like -rw-r--r--" for every stat translator (FUSE attrs, guest
# st_mode); mirrors utils/stat_view.ts.
# The type bits of a mode, as a mask: python's stat.S_IFMT is a function
# of a mode, TypeScript's the mask itself.
S_IFMT = 0o170000
CHAR_MODE = S_IFCHR | 0o666
DIR_MODE = S_IFDIR | 0o755
FILE_MODE = S_IFREG | 0o644
# A pipe is created rw------- (GNU: `stat -L -c %A <(true)`).
FIFO_MODE = S_IFIFO | 0o600
# A link is always lrwxrwxrwx: the bits on a symlink are not consulted
# by any POSIX system, so this is the one mode every translator reports
# for one (FUSE's link_stat, find's -type l row, a guest's lstat).
LINK_MODE = S_IFLNK | 0o777
BASE_MODES = {
    FileType.FILE: FILE_MODE,
    FileType.DIRECTORY: DIR_MODE,
    FileType.SYMLINK: LINK_MODE,
    FileType.CHAR_DEVICE: CHAR_MODE,
    FileType.FIFO: FIFO_MODE,
    FileType.BLOCK_DEVICE: S_IFBLK | 0o644,
    FileType.SOCKET: S_IFSOCK | 0o644,
}
MODE_TYPES = {mode & S_IFMT: kind for kind, mode in BASE_MODES.items()}


def mode_type(mode: int) -> FileType | None:
    """Read the POSIX node kind from a mode that may carry only permissions."""
    return MODE_TYPES.get(mode & S_IFMT)


# A directory is one ext4 block, the st_size GNU tools show for one,
# whatever aggregate a backend reports; ls, stat, find and FUSE all
# report this, so find -size agrees with what the listing shows.
DIR_SIZE = 4096

# The block size every stat translator reports: a backend has none of
# its own, and 4 KiB is what the kernel adapters answer. st_blocks counts
# in BLOCK_UNIT whatever the block size, as POSIX has it.
BLKSIZE = 4096
BLOCK_UNIT = 512

# The longest target ext4 keeps inside a symlink's inode, which takes no
# block of its own (a "fast" symlink); a longer one takes blocks as a
# file of that size does.
FAST_LINK_MAX = 59

# The bits chmod sets: permissions plus setuid, setgid and sticky,
# everything but the file type.
ALL_MODE_BITS = 0o7777

# The largest id a uid_t or gid_t holds. chown and chgrp refuse it, which
# the kernel reads as "leave it unchanged".
ID_MAX = 0xFFFFFFFF

# FNV-1a, 64-bit: the same arithmetic on both hosts and in every
# runtime, so one path reports one inode whoever asks.
_FNV_OFFSET = 0xCBF29CE484222325
_FNV_PRIME = 0x100000001B3
_FNV_MASK = 0xFFFFFFFFFFFFFFFF


def ident(text: str) -> int:
    """A stable, distinct id for one name, as a stat's ino and dev.

    ``os.path.samefile`` compares (st_dev, st_ino) pairs and
    ``os.path.ismount`` compares a path's pair with its parent's, so
    reporting zero for both would make every mounted file the same file
    and every mount root invisible. Derived from the name rather than
    counted, so two processes reading the same workspace agree and a
    repeated stat of one path does not move. The top 48 bits of the
    hash, which a JS number holds exactly.

    Args:
        text (str): the virtual path or mount prefix to identify.
    """
    value = _FNV_OFFSET
    for byte in text.encode():
        value = ((value ^ byte) * _FNV_PRIME) & _FNV_MASK
    return value >> 16


def mtime_ns(st: FileStat) -> int | None:
    """A FileStat's mtime as epoch nanoseconds, None when unknown.

    Delegates to ``iso_timestamp`` rather than re-parsing, which is the
    whole point: an offset-less stamp is read as UTC so every
    translator (FUSE, wasm, the TS bridge) answers the same epoch,
    instead of three of them drifting by the host's UTC offset. None
    (missing or unparseable stamp) is distinct from 0, which is the
    real answer for 1970-01-01T00:00:00Z; a wire with no validity
    channel collapses the two at its own boundary.

    Args:
        st (FileStat): the stat whose ``modified`` field to read.
    """
    seconds = iso_timestamp(st.modified)
    if seconds is None:
        return None
    return int(seconds * 1_000_000_000)


def atime_ns(st: FileStat) -> int | None:
    """A FileStat's atime as epoch nanoseconds, None when unknown.

    Read the way ``mtime_ns`` reads the mtime.

    Args:
        st (FileStat): the stat whose ``atime`` field to read.
    """
    seconds = iso_timestamp(st.atime)
    if seconds is None:
        return None
    return int(seconds * 1_000_000_000)


def posix_mode(st: FileStat) -> int:
    """The st_mode a stat consumer should report for one FileStat.

    The type bits come from the entry's kind and the permission bits
    from the namespace overlay when a chmod put one there, which is what
    makes a metadata write visible to a guest and to a mount alike. A
    backend that reports no mode keeps the default rw-r--r-- / rwxr-xr-x
    pair (rw------- for a FIFO); there are no permissions to read on an
    object store.

    A link is the exception in both halves: its type bits are S_IFLNK
    and its permission bits are always 0777, because no POSIX system
    consults the bits on a symlink. An overlay mode a ``chmod -h`` wrote
    is therefore not reported here (ownership is, since ``chown -h``
    does change what ``ls -l`` shows).

    Args:
        st (FileStat): the stat to translate.
    """
    if is_link(st):
        return LINK_MODE
    base = BASE_MODES[st.type]
    if st.mode is None:
        return base
    return (base & ~ALL_MODE_BITS) | (st.mode & ALL_MODE_BITS)


def is_dir(st: FileStat) -> bool:
    """Whether a FileStat describes a directory.

    Args:
        st (FileStat): the stat to inspect.
    """
    return st.type == FileType.DIRECTORY


def is_link(st: FileStat) -> bool:
    """Whether a FileStat describes a symlink.

    Args:
        st (FileStat): the stat to inspect.
    """
    return st.type == FileType.SYMLINK


def is_char_device(st: FileStat) -> bool:
    """Whether a FileStat describes a character device."""
    return st.type == FileType.CHAR_DEVICE


def is_fifo(st: FileStat) -> bool:
    """Whether a FileStat describes a FIFO.

    Args:
        st (FileStat): the stat to inspect.
    """
    return st.type == FileType.FIFO


def device_rdev(st: FileStat) -> int:
    """Encode a character device's logical major:minor for guest stat."""
    values = st.extra.get(DEVICE_NUMBERS_KEY)
    if not isinstance(values, (list, tuple)) or len(values) != 2:
        return 0
    major, minor = values
    if not isinstance(major, int) or not isinstance(minor, int):
        return 0
    return (major << 8) | minor


def content_size(st: FileStat) -> int:
    """The byte size a stat consumer should report, 0 when unknown.

    A directory is always ``DIR_SIZE``, whatever aggregate a backend
    put in ``size`` (Graph folders report a subtree total there); an
    unknown file size is 0 and rides the unknown-size machinery above.

    Args:
        st (FileStat): the stat to inspect.
    """
    if is_dir(st):
        return DIR_SIZE
    return st.size or 0


def link_count(st: FileStat) -> int:
    """The link count a stat consumer should report: the backend's, else
    1, what a file system that counts no links (btrfs for a directory)
    reports.

    Args:
        st (FileStat): the stat to inspect.
    """
    return 1 if st.nlink is None else st.nlink


def block_count(st: FileStat) -> int | None:
    """The 512-byte blocks a stat consumer should report: the backend's,
    else what ext4 allocates for the entry, whole ``BLKSIZE`` blocks for
    its bytes, none for an empty file, a FIFO, a device or a symlink
    short enough to sit in its inode; None for a file whose size is
    unknown, whose blocks are unknown with it.

    Args:
        st (FileStat): the stat to inspect.
    """
    if st.blocks is not None:
        return st.blocks
    if st.type == FileType.FILE and st.size is None:
        return None
    if st.type in (FileType.FILE, FileType.DIRECTORY):
        size = content_size(st)
    elif is_link(st) and (st.size or 0) > FAST_LINK_MAX:
        size = st.size or 0
    else:
        return 0
    return -(-size // BLKSIZE) * (BLKSIZE // BLOCK_UNIT)


def size_unknown(st: FileStat) -> bool:
    """Whether a listing has no size to show for one FileStat.

    A directory shows ``DIR_SIZE`` and a FIFO, which stores nothing, 0 (as
    GNU's ``stat`` and ``ls -l`` do); any other entry its rendered length.

    Args:
        st (FileStat): the stat to inspect.
    """
    return st.size is None and not is_dir(st) and not is_fifo(st)


def id_number(text: str) -> int | None:
    """The id an owner or group names as a number: ASCII digits after an
    optional ``+``, the form ``chown``, ``id`` and ``find -user`` read
    as a number, leading zeros and all; None for anything else or an id
    past :data:`ID_MAX`.

    Args:
        text (str): the owner or group as typed or reported.
    """
    digits = text[1:] if text.startswith("+") else text
    if not (digits.isascii() and digits.isdigit()):
        return None
    digits = digits.lstrip("0")
    if len(digits) > len(str(ID_MAX)):
        return None
    number = int(digits or "0")
    return number if number <= ID_MAX else None
