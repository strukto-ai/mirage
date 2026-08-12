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

# WASI preview1 wire numbers, from wasi-libc's errno.h (alphabetical
# numbering). These are NOT the host's POSIX values and must never be
# collapsed with them: ENOENT is 44 on the wire and 2 in Python's errno
# module, and 18 here is EDOM where the host's 18 is EXDEV.
WASI: dict[FsCondition, int] = {
    FsCondition.ENOENT: 44,
    FsCondition.ENOTDIR: 54,
    FsCondition.EISDIR: 31,
    FsCondition.EEXIST: 20,
    FsCondition.EACCES: 2,
    FsCondition.EPERM: 63,
    FsCondition.ENOTEMPTY: 55,
    FsCondition.EXDEV: 75,
    # Each mount is its own preopen to a WASI guest, so a rename between
    # two of them reads as a destination that is not there. pathlib's
    # EXDEV is the monty dialect's answer, not this wire's; the row IS
    # that decision (finding 8), moved here from wasm/abi.py.
    FsCondition.CROSS_MOUNT: 44,
    FsCondition.ENOTSUP: 58,
    FsCondition.ELOOP: 32,
    FsCondition.EINVAL: 28,
    FsCondition.EIO: 29,
    FsCondition.EBUSY: 10,
    FsCondition.EROFS: 69,
    # preview1 has no xattr syscalls, so this row is unreachable from a
    # guest; ENOTSUP is the honest answer if a future host ever asks.
    FsCondition.NO_XATTR: 58,
}


def wasi_errno(condition: FsCondition) -> int:
    """The preview1 wire number for a condition.

    Args:
        condition (FsCondition): the named condition.
    """
    return WASI[condition]
