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

from mirage.errors import FsCondition
from mirage.runtime.constants import HARD_LINK_REFUSAL
from mirage.runtime.wasm.errors import (
    EINVAL,
    EIO,
    ENOENT,
    ENOTDIR,
    LINK_REFUSAL,
    WASI,
    errno_for,
    wasi_errno,
)
from mirage.utils.errors import no_mount
from mirage.utils.path import CycleError


def test_errno_map_covers_fs_exceptions():
    assert errno_for(FileNotFoundError("x")) == ENOENT
    assert errno_for(FileExistsError("x")) == wasi_errno(FsCondition.EEXIST)
    assert errno_for(IsADirectoryError("x")) == wasi_errno(FsCondition.EISDIR)
    assert errno_for(NotADirectoryError("x")) == ENOTDIR
    assert errno_for(PermissionError("x")) == wasi_errno(FsCondition.EACCES)
    assert errno_for(NotImplementedError("x")) == wasi_errno(
        FsCondition.ENOTSUP
    )
    assert errno_for(OSError(host_errno.EXDEV, "x")) == wasi_errno(
        FsCondition.EXDEV
    )
    assert errno_for(OSError("boom")) == EIO
    # A path outside every mount is a miss, the same answer the FUSE
    # classifier gives the kernel. Only the registry's typed miss reads
    # that way: a backend's bare ValueError is a refusal, not absence,
    # and keeps the EINVAL fallback.
    assert errno_for(no_mount("/x")) == ENOENT
    assert errno_for(ValueError("row too large")) == EINVAL


def test_errno_values_are_preview1_not_posix():
    # The wire ABI numbers its errnos independently of the host: ENOENT
    # is 2 in Python's errno module but 44 on the wire.
    assert ENOENT == 44
    assert wasi_errno(FsCondition.EACCES) == 2
    assert host_errno.ENOENT == 2


def test_exdev_is_wasi_libc_75_not_the_host_18():
    # wasi-libc numbers alphabetically: 18 on this wire is EDOM, and a
    # real cross-device rename forwarded from a disk backend arrived as
    # a math-domain error in the guest. Same numbering-bug family as
    # pyodide's EXDEV=75 fix.
    assert wasi_errno(FsCondition.EXDEV) == 75


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
        FsCondition.CROSS_MOUNT: 75,
        FsCondition.ENOTSUP: 58,
        FsCondition.ELOOP: 32,
        FsCondition.EINVAL: 28,
        FsCondition.EIO: 29,
        FsCondition.EBUSY: 10,
        FsCondition.EROFS: 69,
        FsCondition.NO_XATTR: 58,
    }


def test_link_refusal_is_the_shared_decision_in_preview1_numbers():
    # The surface renders the refusal, the shared constant decides it:
    # pinning the translation rather than the number is what keeps a
    # change to that decision from silently leaving preview1 behind.
    assert LINK_REFUSAL == wasi_errno(HARD_LINK_REFUSAL)
    assert LINK_REFUSAL == WASI[FsCondition.EPERM]
