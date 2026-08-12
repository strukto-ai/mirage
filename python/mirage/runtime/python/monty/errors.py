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

from dataclasses import dataclass

from mirage.errors import FsCondition


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


# The monty encoders' view: which builtin exception a guest should be
# able to `except`, with CPython-on-Linux numbering. The table is total
# over the vocabulary; test_errors.py fails a half-added member.
CPYTHON: dict[FsCondition, CPythonError] = {
    FsCondition.ENOENT:
    CPythonError("FileNotFoundError", 2, "No such file or directory"),
    FsCondition.ENOTDIR:
    CPythonError("NotADirectoryError", 20, "Not a directory"),
    FsCondition.EISDIR:
    CPythonError("IsADirectoryError", 21, "Is a directory"),
    FsCondition.EEXIST:
    CPythonError("FileExistsError", 17, "File exists"),
    FsCondition.EACCES:
    CPythonError("PermissionError", 13, "Permission denied"),
    FsCondition.EPERM:
    CPythonError("PermissionError", 1, "Operation not permitted"),
    FsCondition.ENOTEMPTY:
    CPythonError("OSError", 39, "Directory not empty"),
    FsCondition.EXDEV:
    CPythonError("OSError", 18, "Invalid cross-device link"),
    # pathlib's answer for a cross-mount rename: monty ships no shutil,
    # so guest code writes the copy-and-delete fallback by hand and the
    # errno is what tells it to.
    FsCondition.CROSS_MOUNT:
    CPythonError("OSError", 18, "Invalid cross-device link"),
    FsCondition.ENOTSUP:
    CPythonError("OSError", 95, "Operation not supported"),
    FsCondition.ELOOP:
    CPythonError("OSError", 40, "Too many levels of symbolic links"),
    FsCondition.EINVAL:
    CPythonError("OSError", 22, "Invalid argument"),
    FsCondition.EIO:
    CPythonError("OSError", 5, "Input/output error"),
    FsCondition.EBUSY:
    CPythonError("OSError", 16, "Device or resource busy"),
    FsCondition.EROFS:
    CPythonError("OSError", 30, "Read-only file system"),
    FsCondition.NO_XATTR:
    CPythonError("OSError", 61, "No data available"),
}


def cpython_error(condition: FsCondition) -> CPythonError:
    """The guest-python rendering for a condition.

    Args:
        condition (FsCondition): the named condition.
    """
    return CPYTHON[condition]
