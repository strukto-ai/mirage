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

import ctypes
import errno
import logging
import sys
from ctypes import CFUNCTYPE, POINTER, c_char_p, c_int, c_uint
from typing import Any

from mirage.types import JsonValue

try:
    import mfusepy
except ImportError:
    mfusepy = None

logger = logging.getLogger(__name__)

# macFUSE's libfuse extends fuse_operations with Darwin-only callbacks
# (fuse.h, inside #ifdef __APPLE__). mfusepy does not declare them: its
# struct ends with 13 reserved pointer slots exactly where the Apple tail
# lives, so libfuse sees NULL for every extended op. The kext path never
# needs them, which is why this went unnoticed. The FSKit backend does:
# the shim finalizes createItem/createDirectory with a SETATTR carrying
# mode|uid|gid|crtime|flags, which macFUSE's high level routes to
# setattr_x, and routes rename through renamex. With those slots NULL,
# libfuse answers ENOSYS *after* our CREATE/MKDIR already succeeded, so
# the file lands and the syscall still fails, and rename never reaches
# userspace at all. Verified with a libfuse wire trace:
#   unique: 43, CREATE  -> success
#   unique: 44, SETATTR -> error: -78 (Function not implemented)
# Related macFUSE FSKit-shim reports (different bugs, same layer):
# https://github.com/macfuse/macfuse/issues/1181 (exec EIO until read),
# https://github.com/macfuse/macfuse/issues/1165 (root readdir cache),
# https://github.com/macfuse/macfuse/issues/1167 (item identity, fixed).

SETATTR_MODE = 1 << 0
SETATTR_UID = 1 << 1
SETATTR_GID = 1 << 2
SETATTR_SIZE = 1 << 3
SETATTR_ACCTIME = 1 << 4
SETATTR_MODTIME = 1 << 5

# renamex_np(2) flags; the FSKit shim passes RENAME_EXCL for a plain mv.
RENAME_SWAP = 0x2
RENAME_EXCL = 0x4

_REPLACED = ("reserved00", "reserved01", "__todo__")

_installed = False


class Timespec(ctypes.Structure):
    """struct timespec on Darwin: two C longs."""

    _fields_ = [
        ("tv_sec", ctypes.c_long),
        ("tv_nsec", ctypes.c_long),
    ]


class SetattrX(ctypes.Structure):
    """Mirror of struct setattr_x (macFUSE fuse_common.h).

    Field types follow the Darwin C ABI: mode_t is uint16, uid_t/gid_t are
    uint32, off_t is int64; ctypes inserts the same padding the C compiler
    does, so no explicit pack/pad fields are needed.
    """

    _fields_ = [
        ("valid", ctypes.c_int32),
        ("mode", ctypes.c_uint16),
        ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32),
        ("size", ctypes.c_int64),
        ("acctime", Timespec),
        ("modtime", Timespec),
        ("crtime", Timespec),
        ("chgtime", Timespec),
        ("bkuptime", Timespec),
        ("flags", ctypes.c_uint32),
    ]


def timespec_to_float(ts: Timespec) -> float:
    """Convert a C timespec to seconds.

    Args:
        ts (Timespec): the C timespec value.

    Returns:
        float: seconds with nanosecond fraction.
    """
    return ts.tv_sec + ts.tv_nsec / 1e9


def changes_from_setattr(attr: SetattrX) -> dict[str, JsonValue]:
    """Decompose a setattr_x payload into named changes.

    Only the attributes mirage models are surfaced; crtime, chgtime,
    bkuptime and BSD flags are accepted and dropped, matching how the
    kext path treats metadata mirage does not store.

    Args:
        attr (SetattrX): the C payload from libfuse.

    Returns:
        dict[str, JsonValue]: present attributes keyed by name.
    """
    valid = attr.valid
    changes: dict[str, JsonValue] = {}
    if valid & SETATTR_MODE:
        changes["mode"] = attr.mode
    if valid & SETATTR_UID:
        changes["uid"] = attr.uid
    if valid & SETATTR_GID:
        changes["gid"] = attr.gid
    if valid & SETATTR_SIZE:
        changes["size"] = attr.size
    if valid & SETATTR_ACCTIME:
        changes["acctime"] = timespec_to_float(attr.acctime)
    if valid & SETATTR_MODTIME:
        changes["modtime"] = timespec_to_float(attr.modtime)
    return changes


def rename_flags_check(new_exists: bool, flags: int) -> int | None:
    """Validate renamex flags against the destination state.

    Args:
        new_exists (bool): whether the destination path already exists.
        flags (int): renamex_np flags from the kernel.

    Returns:
        int | None: an errno to fail with, or None to proceed.
    """
    if flags & RENAME_SWAP:
        # Atomic swap needs both entries exchanged in one step; mirage
        # backends have no such primitive, so refuse rather than fake it.
        return errno.ENOTSUP
    if flags & RENAME_EXCL and new_exists:
        return errno.EEXIST
    return None


def _marshal_setattr_x(self: Any, path: bytes,
                       attr: "ctypes._Pointer[SetattrX]") -> int:
    return self.operations.setattr_x(path.decode(self.encoding),
                                     changes_from_setattr(attr.contents))


def _marshal_fsetattr_x(self: Any, path: bytes,
                        attr: "ctypes._Pointer[SetattrX]",
                        fip: "ctypes._Pointer[ctypes.Structure]") -> int:
    fh = fip.contents.fh if fip else None
    return self.operations.fsetattr_x(path.decode(self.encoding),
                                      changes_from_setattr(attr.contents), fh)


def _marshal_renamex(self: Any, old: bytes, new: bytes, flags: int) -> int:
    return self.operations.renamex(old.decode(self.encoding),
                                   new.decode(self.encoding), flags)


def install_macfuse_extensions() -> None:
    """Teach mfusepy the Darwin-only callbacks the FSKit backend needs.

    Replaces mfusepy's reserved tail slots with macFUSE's real Apple
    fields (fuse.h declaration order after fallocate) and attaches
    marshalling methods for setattr_x, fsetattr_x and renamex. Only those
    three carry callbacks; the rest stay opaque pointers and therefore
    NULL, and macFUSE prefers setattr_x over the per-attribute
    setcrtime/setchgtime/chflags entry points when it is non-NULL, so one
    decomposing callback covers them all. Idempotent, and a no-op off
    macOS or without mfusepy. Layout safety is asserted: the extended
    struct must be byte-identical in size to the one mfusepy already
    hands to libfuse.
    """
    global _installed
    if _installed or mfusepy is None:
        return
    # Guard on the observable layout, not mfusepy's _system tag: the
    # 'Darwin-MacFuse' alias needs a macfuse_version symbol current macFUSE
    # libfuse builds do not export, so it reads plain 'Darwin' here.
    if sys.platform != "darwin":
        return
    names = [f[0] for f in mfusepy.fuse_operations._fields_]
    if any(name not in names for name in _REPLACED):
        logger.warning(
            "mfusepy fuse_operations layout changed; macFUSE extensions "
            "not installed")
        return
    base = [
        f for f in mfusepy.fuse_operations._fields_ if f[0] not in _REPLACED
    ]
    apple_tail = [
        ("reserved00", ctypes.c_void_p),
        ("monitor", ctypes.c_void_p),
        ("renamex", CFUNCTYPE(c_int, c_char_p, c_char_p, c_uint)),
        ("statfs_x", ctypes.c_void_p),
        ("setvolname", ctypes.c_void_p),
        ("exchange", ctypes.c_void_p),
        ("getxtimes", ctypes.c_void_p),
        ("setbkuptime", ctypes.c_void_p),
        ("setchgtime", ctypes.c_void_p),
        ("setcrtime", ctypes.c_void_p),
        ("chflags", ctypes.c_void_p),
        ("setattr_x", CFUNCTYPE(c_int, c_char_p, POINTER(SetattrX))),
        ("fsetattr_x",
         CFUNCTYPE(c_int, c_char_p, POINTER(SetattrX),
                   POINTER(mfusepy.fuse_file_info))),
    ]

    class fuse_operations_apple(ctypes.Structure):
        _fields_ = base + apple_tail

    if ctypes.sizeof(fuse_operations_apple) != ctypes.sizeof(
            mfusepy.fuse_operations):
        logger.warning(
            "macFUSE extension layout mismatch; leaving mfusepy untouched")
        return
    mfusepy.fuse_operations = fuse_operations_apple
    mfusepy.FUSE.setattr_x = _marshal_setattr_x
    mfusepy.FUSE.fsetattr_x = _marshal_fsetattr_x
    mfusepy.FUSE.renamex = _marshal_renamex
    _installed = True
