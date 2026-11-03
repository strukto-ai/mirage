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
    FsCondition.EBADF: PosixErrno(errno.EBADF, "Bad file descriptor"),
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
    FsCondition.EFBIG: PosixErrno(errno.EFBIG, "File too large"),
    FsCondition.EDQUOT: PosixErrno(errno.EDQUOT, "Disk quota exceeded"),
    FsCondition.EPIPE: PosixErrno(errno.EPIPE, "Broken pipe"),
    FsCondition.NO_XATTR: _NO_XATTR,
    FsCondition.STALE_WRITE: PosixErrno(
        errno.ESTALE,
        "changed since it was read; read it again before writing",
    ),
}

# The numbers Linux gives each condition, whatever host mirage runs on: a
# program that imitates a Linux binary prints them (ripgrep's ``(os error
# N)``), and the table above follows the host instead (macOS ELOOP is 62).
# TypeScript's POSIX table is this numbering already.
LINUX_ERRNO: dict[FsCondition, int] = {
    FsCondition.EBADF: 9,
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
    FsCondition.EFBIG: 27,
    FsCondition.EDQUOT: 122,
    FsCondition.EPIPE: 32,
    FsCondition.NO_XATTR: 61,
    FsCondition.STALE_WRITE: 116,
}


def posix_errno(condition: FsCondition) -> int:
    """The host errno for a condition.

    Args:
        condition (FsCondition): the named condition.
    """
    return POSIX[condition].errno


def posix_phrase(condition: FsCondition) -> str:
    """The strerror text for a condition.

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


# Linux's number for each errno name, whatever the host, so a recorded
# error reads the same from either host on any platform (macOS ENOSPC
# matches, its ENAMETOOLONG is 63). The names after ECANCELED share a
# number with one before them and are never the name a number renders as.
ERRNO_NUMBERS: dict[str, int] = {
    "EPERM": 1,
    "ENOENT": 2,
    "ESRCH": 3,
    "EINTR": 4,
    "EIO": 5,
    "ENXIO": 6,
    "E2BIG": 7,
    "ENOEXEC": 8,
    "EBADF": 9,
    "ECHILD": 10,
    "EAGAIN": 11,
    "ENOMEM": 12,
    "EACCES": 13,
    "EFAULT": 14,
    "ENOTBLK": 15,
    "EBUSY": 16,
    "EEXIST": 17,
    "EXDEV": 18,
    "ENODEV": 19,
    "ENOTDIR": 20,
    "EISDIR": 21,
    "EINVAL": 22,
    "ENFILE": 23,
    "EMFILE": 24,
    "ENOTTY": 25,
    "ETXTBSY": 26,
    "EFBIG": 27,
    "ENOSPC": 28,
    "ESPIPE": 29,
    "EROFS": 30,
    "EMLINK": 31,
    "EPIPE": 32,
    "EDOM": 33,
    "ERANGE": 34,
    "EDEADLK": 35,
    "ENAMETOOLONG": 36,
    "ENOLCK": 37,
    "ENOSYS": 38,
    "ENOTEMPTY": 39,
    "ELOOP": 40,
    "ENOMSG": 42,
    "EIDRM": 43,
    "ENODATA": 61,
    "ETIME": 62,
    "EREMOTE": 66,
    "ENOLINK": 67,
    "EPROTO": 71,
    "EBADMSG": 74,
    "EOVERFLOW": 75,
    "EILSEQ": 84,
    "EUSERS": 87,
    "ENOTSOCK": 88,
    "EDESTADDRREQ": 89,
    "EMSGSIZE": 90,
    "EPROTOTYPE": 91,
    "ENOPROTOOPT": 92,
    "EPROTONOSUPPORT": 93,
    "ENOTSUP": 95,
    "EAFNOSUPPORT": 97,
    "EADDRINUSE": 98,
    "EADDRNOTAVAIL": 99,
    "ENETDOWN": 100,
    "ENETUNREACH": 101,
    "ENETRESET": 102,
    "ECONNABORTED": 103,
    "ECONNRESET": 104,
    "ENOBUFS": 105,
    "EISCONN": 106,
    "ENOTCONN": 107,
    "ESHUTDOWN": 108,
    "ETIMEDOUT": 110,
    "ECONNREFUSED": 111,
    "EHOSTDOWN": 112,
    "EHOSTUNREACH": 113,
    "EALREADY": 114,
    "EINPROGRESS": 115,
    "ESTALE": 116,
    "EDQUOT": 122,
    "ECANCELED": 125,
    "EWOULDBLOCK": 11,
    "EDEADLOCK": 35,
    "EOPNOTSUPP": 95,
    "ENOATTR": 61,
}

_ERRNO_NAMES: dict[int, str] = {
    number: name for name, number in reversed(ERRNO_NUMBERS.items())
}


def errno_of(exc: BaseException | None) -> int | None:
    """The number Linux gives an error's errno, None for an error that
    carries none or one Linux has no number for.

    Args:
        exc (BaseException | None): the raw error, before any restamp.
    """
    number = getattr(exc, "errno", None)
    if not isinstance(number, int):
        return None
    name = errno.errorcode.get(number)
    return None if name is None else ERRNO_NUMBERS.get(name)


def errno_name(number: int) -> str | None:
    """The errno name of a Linux errno number, None for one it lacks.

    Args:
        number (int): a number :func:`errno_of` returned.
    """
    return _ERRNO_NAMES.get(number)
