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

import errno

from mirage.errors.types import FsCondition, PosixSeat

# "attribute not set": ENOATTR on macOS, ENODATA on Linux. One
# condition, resolved once; the phrase follows the number so a raw
# strerror on either platform reads consistently.
_NO_XATTR = (PosixSeat(errno.ENOATTR, "Attribute not found") if hasattr(
    errno, "ENOATTR") else PosixSeat(errno.ENODATA, "No data available"))

POSIX: dict[FsCondition, PosixSeat] = {
    FsCondition.ENOENT:
    PosixSeat(errno.ENOENT, "No such file or directory"),
    FsCondition.ENOTDIR:
    PosixSeat(errno.ENOTDIR, "Not a directory"),
    FsCondition.EISDIR:
    PosixSeat(errno.EISDIR, "Is a directory"),
    FsCondition.EEXIST:
    PosixSeat(errno.EEXIST, "File exists"),
    FsCondition.EACCES:
    PosixSeat(errno.EACCES, "Permission denied"),
    FsCondition.EPERM:
    PosixSeat(errno.EPERM, "Operation not permitted"),
    FsCondition.ENOTEMPTY:
    PosixSeat(errno.ENOTEMPTY, "Directory not empty"),
    FsCondition.EXDEV:
    PosixSeat(errno.EXDEV, "Invalid cross-device link"),
    # A cross-mount rename is EXDEV to every POSIX consumer: the kernel
    # reads it as "not one filesystem" and mv falls back to copy+unlink.
    FsCondition.CROSS_MOUNT:
    PosixSeat(errno.EXDEV, "Invalid cross-device link"),
    FsCondition.ENOTSUP:
    PosixSeat(errno.ENOTSUP, "Operation not supported"),
    FsCondition.ELOOP:
    PosixSeat(errno.ELOOP, "Too many levels of symbolic links"),
    FsCondition.EINVAL:
    PosixSeat(errno.EINVAL, "Invalid argument"),
    FsCondition.EIO:
    PosixSeat(errno.EIO, "Input/output error"),
    FsCondition.EBUSY:
    PosixSeat(errno.EBUSY, "Device or resource busy"),
    FsCondition.EROFS:
    PosixSeat(errno.EROFS, "Read-only file system"),
    FsCondition.NO_XATTR:
    _NO_XATTR,
}


def posix_errno(condition: FsCondition) -> int:
    """The host errno for a condition.

    Args:
        condition (FsCondition): the named condition.
    """
    return POSIX[condition].errno


def gnu_phrase(condition: FsCondition) -> str:
    """The GNU strerror text for a condition.

    Args:
        condition (FsCondition): the named condition.
    """
    return POSIX[condition].phrase
