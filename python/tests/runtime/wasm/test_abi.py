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

from mirage.runtime.wasm.abi import (EACCES, EEXIST, EINVAL, EIO, EISDIR,
                                     ENOENT, ENOTDIR, ENOTSUP, EXDEV, FT_DIR,
                                     FT_REG, errno_for, pack_dirent,
                                     pack_fdstat, pack_filestat, pack_prestat,
                                     unpack_iovs)


def test_errno_map_covers_fs_exceptions():
    assert errno_for(FileNotFoundError("x")) == ENOENT
    assert errno_for(FileExistsError("x")) == EEXIST
    assert errno_for(IsADirectoryError("x")) == EISDIR
    assert errno_for(NotADirectoryError("x")) == ENOTDIR
    assert errno_for(PermissionError("x")) == EACCES
    assert errno_for(NotImplementedError("x")) == ENOTSUP
    assert errno_for(OSError(host_errno.EXDEV, "x")) == EXDEV
    assert errno_for(OSError("boom")) == EIO
    assert errno_for(ValueError("no mount matches")) == EINVAL


def test_errno_values_are_preview1_not_posix():
    # The wire ABI numbers its errnos independently of the host: ENOENT
    # is 2 in Python's errno module but 44 on the wire.
    assert ENOENT == 44
    assert EACCES == 2
    assert host_errno.ENOENT == 2


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
