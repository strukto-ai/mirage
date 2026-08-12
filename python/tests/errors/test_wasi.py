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

from mirage.errors.types import FsCondition
from mirage.errors.wasi import WASI, wasi_errno


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
    assert wasi_errno(FsCondition.CROSS_MOUNT) != wasi_errno(
        FsCondition.EXDEV)
