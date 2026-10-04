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

from mirage.errors import FsCondition, classify
from mirage.runtime.constants import HARD_LINK_REFUSAL

# WASI preview1 wire numbers, from wasi-libc's errno.h (alphabetical
# numbering). These are NOT the host's POSIX values and must never be
# collapsed with them: ENOENT is 44 on the wire and 2 in Python's errno
# module, and 18 here is EDOM where the host's 18 is EXDEV. The table
# is total over the vocabulary; test_errors.py fails a half-added member.
WASI: dict[FsCondition, int] = {
    FsCondition.ENOENT: 44,
    FsCondition.ENOTDIR: 54,
    FsCondition.EISDIR: 31,
    FsCondition.EEXIST: 20,
    FsCondition.EACCES: 2,
    FsCondition.EPERM: 63,
    FsCondition.ENOTEMPTY: 55,
    FsCondition.EXDEV: 75,
    # A rename or link between two mounts is two file systems, as a
    # host answers across two preopens on different devices.
    FsCondition.CROSS_MOUNT: 75,
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


# errno. EBADF stays a local literal because a bad guest fd is the fd
# table's condition, never a mount's, so the vocabulary does not name
# it.
OK = 0
EBADF = 8
EINVAL = wasi_errno(FsCondition.EINVAL)
EIO = wasi_errno(FsCondition.EIO)
ENOENT = wasi_errno(FsCondition.ENOENT)
ENOTDIR = wasi_errno(FsCondition.ENOTDIR)

# Which refusal a hard link gets is decided once, for every surface that
# can spell one; rendering it in preview1 numbers is this one's part.
LINK_REFUSAL = wasi_errno(HARD_LINK_REFUSAL)


def errno_for(exc: BaseException) -> int:
    """Map a host/dispatch exception to its preview1 errno.

    The naming lives in ``mirage.errors.classify`` and the numbering in
    the ``WASI`` table above. An OSError the vocabulary does not name
    degrades to EIO and anything else to EINVAL, matching the arms this
    function carried by hand.

    Args:
        exc (BaseException): exception raised by a WasmView operation.
    """
    condition = classify(exc)
    if condition is not None:
        return wasi_errno(condition)
    if isinstance(exc, OSError):
        return EIO
    return EINVAL
