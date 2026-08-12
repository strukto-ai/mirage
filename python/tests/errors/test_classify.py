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

from mirage.errors.classify import classify
from mirage.errors.posix import POSIX
from mirage.errors.types import FsCondition
from mirage.runtime.errors import CrossMountError
from mirage.utils.errors import enotsup
from mirage.utils.path import CycleError


@pytest.mark.parametrize("exc,expected", [
    (CycleError("/a"), FsCondition.ELOOP),
    (CrossMountError("/a/x", "/b/x"), FsCondition.CROSS_MOUNT),
    (FileNotFoundError("/x"), FsCondition.ENOENT),
    (NotADirectoryError("/x"), FsCondition.ENOTDIR),
    (IsADirectoryError("/x"), FsCondition.EISDIR),
    (FileExistsError("/x"), FsCondition.EEXIST),
    (PermissionError("/x"), FsCondition.EACCES),
    (enotsup("ram", "unlink", "/x"), FsCondition.ENOTSUP),
    (NotImplementedError("append"), FsCondition.ENOTSUP),
    (ValueError("no mount matches path: /x"), FsCondition.ENOENT),
])
def test_class_arms(exc, expected):
    assert classify(exc) is expected


@pytest.mark.parametrize("code,expected", [
    (errno.ENOTEMPTY, FsCondition.ENOTEMPTY),
    (errno.EXDEV, FsCondition.EXDEV),
    (errno.ELOOP, FsCondition.ELOOP),
    (errno.EPERM, FsCondition.EPERM),
    (errno.EBUSY, FsCondition.EBUSY),
    (errno.EROFS, FsCondition.EROFS),
    (errno.EINVAL, FsCondition.EINVAL),
    (errno.EIO, FsCondition.EIO),
])
def test_errno_carrying_oserror_arms(code, expected):
    assert classify(OSError(code, "x")) is expected


def test_xattr_miss_is_one_condition_whatever_the_platform_calls_it():
    # ENOATTR on macOS, ENODATA on Linux: one condition, resolved through
    # the posix seat so the reverse arm matches the running host.
    number = POSIX[FsCondition.NO_XATTR].errno
    assert classify(OSError(number, "x")) is FsCondition.NO_XATTR


def test_a_subclass_wins_over_its_stamped_errno():
    # FileNotFoundError IS an OSError with errno 2; the class arm answers
    # before the errno lookup so the two can never disagree.
    assert classify(FileNotFoundError(errno.ENOENT,
                                      "x")) is FsCondition.ENOENT


@pytest.mark.parametrize("exc", [
    OSError("bare message, no errno"),
    RuntimeError("something else entirely"),
    OSError(errno.ENAMETOOLONG, "outside the vocabulary"),
])
def test_unnamed_conditions_answer_none(exc):
    # None means "no seat": the caller keeps its own fallback (FUSE
    # passes a raw OSError errno through, wasi answers EIO/EINVAL).
    assert classify(exc) is None
