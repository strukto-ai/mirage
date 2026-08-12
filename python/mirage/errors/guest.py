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

from mirage.errors.types import FsCondition, GuestSeat

# The monty encoders' view: which builtin exception a guest should be
# able to `except`, with CPython-on-Linux numbering. A guest
# interpreter is platform-neutral, so these must not wobble with the
# host the way the posix seats do.
GUEST: dict[FsCondition, GuestSeat] = {
    FsCondition.ENOENT:
    GuestSeat("FileNotFoundError", 2, "No such file or directory"),
    FsCondition.ENOTDIR:
    GuestSeat("NotADirectoryError", 20, "Not a directory"),
    FsCondition.EISDIR:
    GuestSeat("IsADirectoryError", 21, "Is a directory"),
    FsCondition.EEXIST:
    GuestSeat("FileExistsError", 17, "File exists"),
    FsCondition.EACCES:
    GuestSeat("PermissionError", 13, "Permission denied"),
    FsCondition.EPERM:
    GuestSeat("PermissionError", 1, "Operation not permitted"),
    FsCondition.ENOTEMPTY:
    GuestSeat("OSError", 39, "Directory not empty"),
    FsCondition.EXDEV:
    GuestSeat("OSError", 18, "Invalid cross-device link"),
    # pathlib's answer for a cross-mount rename: monty ships no shutil,
    # so guest code writes the copy-and-delete fallback by hand and the
    # errno is what tells it to.
    FsCondition.CROSS_MOUNT:
    GuestSeat("OSError", 18, "Invalid cross-device link"),
    FsCondition.ENOTSUP:
    GuestSeat("OSError", 95, "Operation not supported"),
    FsCondition.ELOOP:
    GuestSeat("OSError", 40, "Too many levels of symbolic links"),
    FsCondition.EINVAL:
    GuestSeat("OSError", 22, "Invalid argument"),
    FsCondition.EIO:
    GuestSeat("OSError", 5, "Input/output error"),
    FsCondition.EBUSY:
    GuestSeat("OSError", 16, "Device or resource busy"),
    FsCondition.EROFS:
    GuestSeat("OSError", 30, "Read-only file system"),
    FsCondition.NO_XATTR:
    GuestSeat("OSError", 61, "No data available"),
}


def guest_seat(condition: FsCondition) -> GuestSeat:
    """The guest-python rendering for a condition.

    Args:
        condition (FsCondition): the named condition.
    """
    return GUEST[condition]
