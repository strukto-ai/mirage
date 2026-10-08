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
    StaleWriteError,
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
    (DotWalkLoop, FsCondition.ELOOP),
    (CrossMountError, FsCondition.EXDEV),
    (OperationNotSupportedError, FsCondition.ENOTSUP),
    (NotImplementedError, FsCondition.ENOTSUP),
    (BadDescriptorError, FsCondition.EBADF),
    (FileTooLargeError, FsCondition.EFBIG),
    (StaleWriteError, FsCondition.STALE_WRITE),
    (NotADirectoryError, FsCondition.ENOTDIR),
    (IsADirectoryError, FsCondition.EISDIR),
    (FileExistsError, FsCondition.EEXIST),
    (ReadOnlyError, FsCondition.EROFS),
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
    errno.EBADF: FsCondition.EBADF,
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
    errno.EFBIG: FsCondition.EFBIG,
    POSIX[FsCondition.NO_XATTR].errno: FsCondition.NO_XATTR,
}

# The conditions a command reports against one operand before it moves
# on to the next: the line ends in the condition's phrase. A failure
# outside the set (EIO, a dropped connection) carries its own words.
# Mirrors TS OPERAND_CONDITIONS.
OPERAND_CONDITIONS: frozenset[FsCondition] = frozenset(
    {
        FsCondition.EBADF,
        FsCondition.ENOENT,
        FsCondition.ENOTDIR,
        FsCondition.EISDIR,
        FsCondition.ELOOP,
        FsCondition.EEXIST,
        FsCondition.EROFS,
        FsCondition.EACCES,
        FsCondition.ENOTEMPTY,
        FsCondition.ENOTSUP,
        FsCondition.EXDEV,
        FsCondition.EFBIG,
        FsCondition.STALE_WRITE,
    }
)

# The class a condition is raised as where mirage has one of its own;
# every other condition is a plain OSError, which CPython constructs as
# its builtin subclass (FileNotFoundError for ENOENT).
CONDITION_CLASS: dict[FsCondition, type[OSError]] = {
    FsCondition.EBADF: BadDescriptorError,
    FsCondition.ELOOP: DotWalkLoop,
    FsCondition.EROFS: ReadOnlyError,
    FsCondition.ENOTSUP: OperationNotSupportedError,
    FsCondition.EFBIG: FileTooLargeError,
    FsCondition.STALE_WRITE: StaleWriteError,
}

# The per-operand errors a catch site names by class: every one that
# writes a command line and keeps going. ENOTEMPTY and EXDEV have no
# class, so a plain OSError carrying them renders its phrase but is not
# caught here. Mirrors TS isFsError.
FS_ERRORS: tuple[type[OSError], ...] = (
    BadDescriptorError,
    FileNotFoundError,
    NotADirectoryError,
    IsADirectoryError,
    DotWalkLoop,
    FileExistsError,
    PermissionError,
    OperationNotSupportedError,
    FileTooLargeError,
    StaleWriteError,
)

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


# The failures that happen after the open, which a command words as the
# read step: a directory opens and then refuses the read, and the backend
# contract raises the other two for a read it will not serve.
READ_FAILURES: tuple[type[OSError], ...] = (
    IsADirectoryError,
    FileTooLargeError,
    BadDescriptorError,
)
