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

from mirage.errors import FsCondition, classify, posix_errno

# "attribute not found" errno: ENOATTR on macOS, ENODATA on Linux.
NO_XATTR = posix_errno(FsCondition.NO_XATTR)

# Genuine last resort, for a bare OSError whose only signal is its
# message (ram/redis rmdir raise OSError("directory not empty: ...")).
# The needles that duplicated a typed arm are gone: "read-only" and
# "not allowed to access mount" arrive as PermissionError, "no mount"
# as ValueError, and classify names all three.
_MESSAGE_CODES: tuple[tuple[tuple[str, ...], int], ...] = (
    (("not empty", "enotempty"), errno.ENOTEMPTY),
    (("not a directory", "enotdir"), errno.ENOTDIR),
    (("is a directory", "eisdir"), errno.EISDIR),
    (("permission", "eacces"), errno.EACCES),
    (("file exists", "eexist"), errno.EEXIST),
    (("not found", "no such", "enoent"), errno.ENOENT),
)


def classify_error(err: BaseException) -> int:
    """Map a mirage-native exception onto a POSIX errno.

    The mount core raises ordinary Python exceptions; protocol adapters
    call this to get the numeric code their kernel interface wants. The
    naming lives in ``mirage.errors.classify`` (shared with the wasi
    host and, through its TS twin, both fuse-native and the monty
    encoders); this adapter only renders the condition in host POSIX
    numbers. An OSError whose errno has no seat in the vocabulary is
    passed through untouched (ENAMETOOLONG reaches the kernel as
    itself), and the message needles are a last resort for bare
    OSErrors, not a classification channel.

    Args:
        err (BaseException): the exception raised by the mount core.

    Returns:
        int: positive POSIX errno; ``errno.EIO`` when nothing matches.
    """
    condition = classify(err)
    if condition is not None:
        return posix_errno(condition)
    if isinstance(err, OSError) and err.errno:
        return err.errno
    text = str(err).lower()
    for needles, code in _MESSAGE_CODES:
        if any(n in text for n in needles):
            return code
    return errno.EIO
