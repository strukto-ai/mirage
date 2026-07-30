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

# "attribute not found" errno: ENOATTR on macOS, ENODATA on Linux.
NO_XATTR = getattr(errno, "ENOATTR", None) or errno.ENODATA

_MESSAGE_CODES: tuple[tuple[tuple[str, ...], int], ...] = (
    (("not empty", "enotempty"), errno.ENOTEMPTY),
    (("not a directory", "enotdir"), errno.ENOTDIR),
    (("is a directory", "eisdir"), errno.EISDIR),
    (("permission", "eacces", "read-only", "not allowed to access mount"),
     errno.EACCES),
    (("file exists", "eexist"), errno.EEXIST),
    (("not found", "no such", "enoent", "no mount"), errno.ENOENT),
)


def classify_error(err: BaseException) -> int:
    """Map a mirage-native exception onto a POSIX errno.

    The mount core raises ordinary Python exceptions; protocol adapters
    call this to get the numeric code their kernel interface wants. This
    mirrors the TypeScript ``classifyError`` so both languages report the
    same errno for the same backend failure.

    Exception *class* is checked before ``OSError.errno`` and before the
    message, because mirage backends raise a mix: some construct
    ``OSError(errno.ENOTEMPTY, ...)``, others a bare
    ``OSError("directory not empty: ...")``.

    Args:
        err (BaseException): the exception raised by the mount core.

    Returns:
        int: positive POSIX errno; ``errno.EIO`` when nothing matches.
    """
    if isinstance(err, NotADirectoryError):
        return errno.ENOTDIR
    if isinstance(err, IsADirectoryError):
        return errno.EISDIR
    if isinstance(err, FileExistsError):
        return errno.EEXIST
    if isinstance(err, PermissionError):
        return errno.EACCES
    if isinstance(err, FileNotFoundError):
        return errno.ENOENT
    # A mount miss ("no mount at /x") is a ValueError in the ops facade.
    if isinstance(err, ValueError):
        return errno.ENOENT
    if isinstance(err, OSError) and err.errno:
        return err.errno
    text = str(err).lower()
    for needles, code in _MESSAGE_CODES:
        if any(n in text for n in needles):
            return code
    return errno.EIO
