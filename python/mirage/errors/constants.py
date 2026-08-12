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
from mirage.errors.types import FsCondition
from mirage.runtime.errors import CrossMountError
from mirage.utils.errors import OperationNotSupportedError
from mirage.utils.path import CycleError

# Exception class beats OSError.errno beats everything, because mirage
# raises a mix: some sites construct OSError(errno.ENOTEMPTY, ...),
# others a typed subclass with no errno at all. Most-specific first:
# every subclass arm must come before the bases it would otherwise
# shadow (OperationNotSupportedError before PermissionError's OSError
# base, FileNotFoundError before the errno lookup).
CLASS_ARMS: tuple[tuple[type[BaseException], FsCondition], ...] = (
    (CycleError, FsCondition.ELOOP),
    (CrossMountError, FsCondition.CROSS_MOUNT),
    (OperationNotSupportedError, FsCondition.ENOTSUP),
    (NotImplementedError, FsCondition.ENOTSUP),
    (NotADirectoryError, FsCondition.ENOTDIR),
    (IsADirectoryError, FsCondition.EISDIR),
    (FileExistsError, FsCondition.EEXIST),
    (PermissionError, FsCondition.EACCES),
    (FileNotFoundError, FsCondition.ENOENT),
    # A mount miss ("no mount matches path: /x") is a ValueError in the
    # registry, and a path outside every mount is simply not there.
    (ValueError, FsCondition.ENOENT),
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
