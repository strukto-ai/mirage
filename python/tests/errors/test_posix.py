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

import pytest

from mirage.errors.posix import POSIX, gnu_phrase, posix_errno
from mirage.errors.types import FsCondition


@pytest.mark.parametrize("cond,number", [
    (FsCondition.ENOENT, errno.ENOENT),
    (FsCondition.ENOTDIR, errno.ENOTDIR),
    (FsCondition.EISDIR, errno.EISDIR),
    (FsCondition.EEXIST, errno.EEXIST),
    (FsCondition.EACCES, errno.EACCES),
    (FsCondition.EPERM, errno.EPERM),
    (FsCondition.ENOTEMPTY, errno.ENOTEMPTY),
    (FsCondition.EXDEV, errno.EXDEV),
    (FsCondition.CROSS_MOUNT, errno.EXDEV),
    (FsCondition.ENOTSUP, errno.ENOTSUP),
    (FsCondition.ELOOP, errno.ELOOP),
    (FsCondition.EINVAL, errno.EINVAL),
    (FsCondition.EIO, errno.EIO),
    (FsCondition.EBUSY, errno.EBUSY),
    (FsCondition.EROFS, errno.EROFS),
])
def test_numbers_come_from_the_host_errno_module(cond, number):
    assert posix_errno(cond) == number


def test_xattr_miss_resolves_per_platform():
    # ENOATTR on macOS, ENODATA on Linux; one condition, one seat.
    expected = getattr(errno, "ENOATTR", None) or errno.ENODATA
    assert posix_errno(FsCondition.NO_XATTR) == expected


@pytest.mark.parametrize("cond,phrase", [
    (FsCondition.ENOENT, "No such file or directory"),
    (FsCondition.ENOTDIR, "Not a directory"),
    (FsCondition.EISDIR, "Is a directory"),
    (FsCondition.EEXIST, "File exists"),
    (FsCondition.EACCES, "Permission denied"),
    (FsCondition.EPERM, "Operation not permitted"),
    (FsCondition.ENOTEMPTY, "Directory not empty"),
    (FsCondition.EXDEV, "Invalid cross-device link"),
    (FsCondition.CROSS_MOUNT, "Invalid cross-device link"),
    (FsCondition.ENOTSUP, "Operation not supported"),
    (FsCondition.ELOOP, "Too many levels of symbolic links"),
    (FsCondition.EINVAL, "Invalid argument"),
    (FsCondition.EIO, "Input/output error"),
    (FsCondition.EBUSY, "Device or resource busy"),
    (FsCondition.EROFS, "Read-only file system"),
])
def test_phrases_are_gnu_strerror(cond, phrase):
    assert gnu_phrase(cond) == phrase


def test_every_seat_has_a_positive_number_and_a_phrase():
    for cond in FsCondition:
        seat = POSIX[cond]
        assert seat.errno > 0
        assert seat.phrase
