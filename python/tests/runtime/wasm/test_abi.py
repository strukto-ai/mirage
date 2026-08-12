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

from mirage.errors import FsCondition
from mirage.runtime.wasm.abi import (EACCES, EEXIST, EIO, EISDIR, ENOENT,
                                     ENOTDIR, ENOTSUP, EXDEV, FT_DIR, FT_REG,
                                     WASI, errno_for, pack_dirent, pack_fdstat,
                                     pack_filestat, pack_prestat, unpack_iovs,
                                     wasi_errno)
from mirage.utils.path import CycleError


def test_errno_map_covers_fs_exceptions():
    assert errno_for(FileNotFoundError("x")) == ENOENT
    assert errno_for(FileExistsError("x")) == EEXIST
    assert errno_for(IsADirectoryError("x")) == EISDIR
    assert errno_for(NotADirectoryError("x")) == ENOTDIR
    assert errno_for(PermissionError("x")) == EACCES
    assert errno_for(NotImplementedError("x")) == ENOTSUP
    assert errno_for(OSError(host_errno.EXDEV, "x")) == EXDEV
    assert errno_for(OSError("boom")) == EIO
    # A path outside every mount is a miss, the same answer the FUSE
    # classifier gives the kernel; EINVAL was the unhandled fallback.
    assert errno_for(ValueError("no mount matches")) == ENOENT


def test_errno_values_are_preview1_not_posix():
    # The wire ABI numbers its errnos independently of the host: ENOENT
    # is 2 in Python's errno module but 44 on the wire.
    assert ENOENT == 44
    assert EACCES == 2
    assert host_errno.ENOENT == 2


def test_exdev_is_wasi_libc_75_not_the_host_18():
    # wasi-libc numbers alphabetically: 18 on this wire is EDOM, and a
    # real cross-device rename forwarded from a disk backend arrived as
    # a math-domain error in the guest. Same numbering-bug family as
    # pyodide's EXDEV=75 fix.
    assert EXDEV == 75


def test_symlink_loop_is_wire_eloop():
    # preview1 number 32; CycleError is not an OSError, so before the
    # shared vocabulary it fell to the EINVAL fallback.
    assert errno_for(CycleError("/a")) == 32


def test_wire_table_covers_the_whole_vocabulary():
    # A condition cannot be half-added: the dialect table stays total
    # over the vocabulary, keyed on exactly the enum.
    assert set(WASI) == set(FsCondition)


def test_preview1_numbering_is_the_wasi_libc_table():
    # wasi-libc errno.h numbering, which is NOT the host's: ENOENT is 44
    # on the wire and 2 in Python's errno module. Pinned literally so a
    # host-errno leak cannot pass.
    assert WASI == {
        FsCondition.ENOENT: 44,
        FsCondition.ENOTDIR: 54,
        FsCondition.EISDIR: 31,
        FsCondition.EEXIST: 20,
        FsCondition.EACCES: 2,
        FsCondition.EPERM: 63,
        FsCondition.ENOTEMPTY: 55,
        FsCondition.EXDEV: 75,
        FsCondition.CROSS_MOUNT: 44,
        FsCondition.ENOTSUP: 58,
        FsCondition.ELOOP: 32,
        FsCondition.EINVAL: 28,
        FsCondition.EIO: 29,
        FsCondition.EBUSY: 10,
        FsCondition.EROFS: 69,
        FsCondition.NO_XATTR: 58,
    }


def test_cross_mount_is_deliberately_noent_on_this_wire():
    # Finding 8: each mount is its own preopen to a WASI guest, so a
    # rename between two of them reads as a destination that is not
    # there. pathlib's EXDEV is the monty dialect's answer, not this
    # one's. The table row IS the decision; do not "fix" it to 75.
    assert wasi_errno(FsCondition.CROSS_MOUNT) == wasi_errno(
        FsCondition.ENOENT)
    assert wasi_errno(FsCondition.CROSS_MOUNT) != wasi_errno(FsCondition.EXDEV)


def test_record_sizes_match_the_preview1_layouts():
    assert len(pack_prestat(1)) == 8
    assert len(pack_fdstat(FT_REG)) == 24
    assert len(pack_filestat(0, 0, FT_REG, 0)) == 64
    assert len(pack_dirent(0, b"abc", FT_DIR)) == 24 + 3


def test_dirent_carries_cookie_name_and_type():
    d_next, d_ino, namelen, ftype = struct.unpack_from(
        "<QQIB", pack_dirent(4, b"f.txt", FT_REG))
    assert (d_next, d_ino, namelen, ftype) == (5, 5, 5, FT_REG)
    assert pack_dirent(4, b"f.txt", FT_REG)[24:] == b"f.txt"


def test_unpack_iovs_decodes_pointer_length_pairs():
    raw = struct.pack("<IIII", 16, 128, 4096, 64)
    assert unpack_iovs(raw, 2) == [(16, 128), (4096, 64)]
