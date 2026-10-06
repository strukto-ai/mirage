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

from mirage.errors.posix import POSIX
from mirage.errors.types import (
    BadDescriptorError,
    DotWalkLoop,
    FileTooLargeError,
    FsCondition,
    NoMountError,
    OperationNotSupportedError,
    ReadOnlyError,
)
from mirage.runtime.errors import CrossMountError
from mirage.utils.path import CycleError

# Exception class beats OSError.errno beats everything, because mirage
# raises a mix: some sites construct OSError(errno.ENOTEMPTY, ...),
# others a typed subclass with no errno at all. Most-specific first:
# every subclass arm must come before the bases it would otherwise
# shadow (OperationNotSupportedError before PermissionError's OSError
# base, FileNotFoundError before the errno lookup).
CLASS_ARMS: tuple[tuple[type[BaseException], FsCondition], ...] = (
    (CycleError, FsCondition.ELOOP),
    (CrossMountError, FsCondition.EXDEV),
    (OperationNotSupportedError, FsCondition.ENOTSUP),
    (NotImplementedError, FsCondition.ENOTSUP),
    (NotADirectoryError, FsCondition.ENOTDIR),
    (IsADirectoryError, FsCondition.EISDIR),
    (FileExistsError, FsCondition.EEXIST),
    (PermissionError, FsCondition.EACCES),
    (FileNotFoundError, FsCondition.ENOENT),
    # Only the registry's typed miss: a path outside every mount is
    # simply not there. A bare ValueError stays unnamed, because
    # backends raise it for refusals that are not absence (an oversized
    # read, a rename into the source's own subtree), and naming those
    # ENOENT would report an existing object as missing.
    (NoMountError, FsCondition.ENOENT),
)

# The reverse arm for a plain OSError that carries a vocabulary errno.
# EOPNOTSUPP is ENOTSUP's second spelling (a distinct number on macOS,
# the same one on Linux); NO_XATTR reads its platform-resolved row.
ERRNO_ARMS: dict[int, FsCondition] = {
    errno.ENOENT: FsCondition.ENOENT,
    errno.ENOTDIR: FsCondition.ENOTDIR,
    errno.EISDIR: FsCondition.EISDIR,
    errno.EEXIST: FsCondition.EEXIST,
    errno.EACCES: FsCondition.EACCES,
    errno.EPERM: FsCondition.EPERM,
    errno.ENOTEMPTY: FsCondition.ENOTEMPTY,
    errno.EXDEV: FsCondition.EXDEV,
    errno.ENOTSUP: FsCondition.ENOTSUP,
    errno.EOPNOTSUPP: FsCondition.ENOTSUP,
    errno.ELOOP: FsCondition.ELOOP,
    errno.EINVAL: FsCondition.EINVAL,
    errno.EIO: FsCondition.EIO,
    errno.EBUSY: FsCondition.EBUSY,
    errno.EROFS: FsCondition.EROFS,
    POSIX[FsCondition.NO_XATTR].errno: FsCondition.NO_XATTR,
}

ELOOP_STRERROR = "Too many levels of symbolic links"


FS_STRERROR: list[tuple[type[OSError], str]] = [
    (BadDescriptorError, "Bad file descriptor"),
    (FileNotFoundError, "No such file or directory"),
    (NotADirectoryError, "Not a directory"),
    (IsADirectoryError, "Is a directory"),
    (DotWalkLoop, ELOOP_STRERROR),
    (FileExistsError, "File exists"),
    (ReadOnlyError, "Read-only file system"),
    (PermissionError, "Permission denied"),
    (OperationNotSupportedError, "Operation not supported"),
    (FileTooLargeError, "File too large"),
]


# The recoverable per-operand filesystem errors: every catch site that
# formats a GNU stderr line and keeps going uses this tuple, so the catch
# set and the strerror table can never drift apart (mirrors TS isFsError).
FS_ERRORS: tuple[type[OSError], ...] = tuple(t for t, _ in FS_STRERROR)


# What a tree walk over a user operand tolerates: every recoverable
# filesystem error, plus the ValueError store backends raise for "not a
# directory". Catch sites that warn and keep walking (tree, grep -r, rg) use
# this so an errno split like ENOENT/ENOTDIR cannot make one of them abort
# while its siblings keep going.
WALK_ERRORS: tuple[type[Exception], ...] = (*FS_ERRORS, ValueError)


# What an existence probe reads as "nothing here": the path is absent, or
# a component of it is not traversable. Deliberately narrower than
# WALK_ERRORS, because a permission or missing-capability error is not
# absence, and mapping it to one would report a path that exists as
# missing. Mirrors TS isMissError.
MISS_ERRORS: tuple[type[Exception], ...] = (
    FileNotFoundError,
    NotADirectoryError,
    IsADirectoryError,
    ValueError,
)


# The failures that happen after the open, which GNU words as the read
# step: a directory opens and then refuses the read, and the backend
# contract raises the other two for a read it will not serve.
READ_FAILURES: tuple[type[OSError], ...] = (
    IsADirectoryError,
    FileTooLargeError,
    BadDescriptorError,
)
