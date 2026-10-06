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

import builtins
from dataclasses import dataclass

from mirage.errors import FsCondition
from mirage.errors.posix import linux_errno, posix_phrase


@dataclass(frozen=True, slots=True)
class CPythonError:
    """The error as guest CPython raises it for one condition.

    Args:
        exception (str): the builtin exception a guest should be able
            to ``except`` (e.g. ``FileNotFoundError``).
        errno (int): CPython-on-Linux errno; a guest interpreter is
            platform-neutral, so the numbering must not wobble with the
            host.
        phrase (str): CPython's message phrase for the errno.
    """

    exception: str
    errno: int
    phrase: str


# The builtin a guest `except`s for a condition, where CPython raises a
# subclass for its errno; every other condition is a plain OSError.
EXCEPTIONS: dict[FsCondition, str] = {
    FsCondition.ENOENT: "FileNotFoundError",
    FsCondition.ENOTDIR: "NotADirectoryError",
    FsCondition.EISDIR: "IsADirectoryError",
    FsCondition.EEXIST: "FileExistsError",
    FsCondition.EACCES: "PermissionError",
    FsCondition.EPERM: "PermissionError",
}


def cpython_error(condition: FsCondition) -> CPythonError:
    """The guest-python rendering for a condition.

    CPython on Linux, since a guest interpreter is platform-neutral: the
    number and the phrase are the shared tables' Linux ones. The host
    table words "attribute not set" by platform (macOS says "Attribute
    not found"), so that one phrase is pinned to Linux's here.

    Args:
        condition (FsCondition): the named condition.
    """
    phrase = posix_phrase(condition)
    if condition is FsCondition.NO_XATTR:
        phrase = "No data available"
    return CPythonError(
        EXCEPTIONS.get(condition, "OSError"), linux_errno(condition), phrase
    )


def guest_error(
    condition: FsCondition, path: str, target: str | None = None
) -> OSError:
    """The guest-side exception for one condition, in CPython's shape.

    CPython's own message for it, so guest code reads the same
    ``[Errno 2] No such file or directory: '/data/x'`` whichever mount
    refused, and the builtin a guest ``except`` names.

    Args:
        condition (FsCondition): the named condition.
        path (str): the path the operation names.
        target (str | None): a rename's destination, which CPython
            prints after the source.
    """
    row = cpython_error(condition)
    kind: type[OSError] = getattr(builtins, row.exception)
    if target is None:
        return kind(row.errno, row.phrase, path)
    return kind(row.errno, row.phrase, path, None, target)
