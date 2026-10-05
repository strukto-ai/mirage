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

from mirage.errors.types import FsCondition, PosixErrno

# "attribute not set": ENOATTR on macOS, ENODATA on Linux. One
# condition, resolved once; the phrase follows the number so a raw
# strerror on either platform reads consistently.
_NO_XATTR = (
    PosixErrno(errno.ENOATTR, "Attribute not found")
    if hasattr(errno, "ENOATTR")
    else PosixErrno(errno.ENODATA, "No data available")
)

POSIX: dict[FsCondition, PosixErrno] = {
    FsCondition.ENOENT: PosixErrno(errno.ENOENT, "No such file or directory"),
    FsCondition.ENOTDIR: PosixErrno(errno.ENOTDIR, "Not a directory"),
    FsCondition.EISDIR: PosixErrno(errno.EISDIR, "Is a directory"),
    FsCondition.EEXIST: PosixErrno(errno.EEXIST, "File exists"),
    FsCondition.EACCES: PosixErrno(errno.EACCES, "Permission denied"),
    FsCondition.EPERM: PosixErrno(errno.EPERM, "Operation not permitted"),
    FsCondition.ENOTEMPTY: PosixErrno(errno.ENOTEMPTY, "Directory not empty"),
    FsCondition.EXDEV: PosixErrno(errno.EXDEV, "Invalid cross-device link"),
    FsCondition.ENOTSUP: PosixErrno(errno.ENOTSUP, "Operation not supported"),
    FsCondition.ELOOP: PosixErrno(
        errno.ELOOP, "Too many levels of symbolic links"
    ),
    FsCondition.EINVAL: PosixErrno(errno.EINVAL, "Invalid argument"),
    FsCondition.EIO: PosixErrno(errno.EIO, "Input/output error"),
    FsCondition.EBUSY: PosixErrno(errno.EBUSY, "Device or resource busy"),
    FsCondition.EROFS: PosixErrno(errno.EROFS, "Read-only file system"),
    FsCondition.NO_XATTR: _NO_XATTR,
}

# The numbers Linux gives each condition, whatever host mirage runs on: a
# program that imitates a Linux binary prints them (ripgrep's ``(os error
# N)``), and the table above follows the host instead (macOS ELOOP is 62).
# TypeScript's POSIX table is this numbering already.
LINUX_ERRNO: dict[FsCondition, int] = {
    FsCondition.ENOENT: 2,
    FsCondition.ENOTDIR: 20,
    FsCondition.EISDIR: 21,
    FsCondition.EEXIST: 17,
    FsCondition.EACCES: 13,
    FsCondition.EPERM: 1,
    FsCondition.ENOTEMPTY: 39,
    FsCondition.EXDEV: 18,
    FsCondition.ENOTSUP: 95,
    FsCondition.ELOOP: 40,
    FsCondition.EINVAL: 22,
    FsCondition.EIO: 5,
    FsCondition.EBUSY: 16,
    FsCondition.EROFS: 30,
    FsCondition.NO_XATTR: 61,
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


def linux_errno(condition: FsCondition) -> int:
    """The number Linux gives a condition, whatever the host.

    Args:
        condition (FsCondition): the named condition.
    """
    return LINUX_ERRNO[condition]
