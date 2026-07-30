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
import os

import pytest

from mirage.fuse.errors import NO_XATTR, classify_error


@pytest.mark.parametrize("err,expected", [
    (NotADirectoryError("x"), errno.ENOTDIR),
    (IsADirectoryError("x"), errno.EISDIR),
    (FileExistsError("x"), errno.EEXIST),
    (PermissionError("x"), errno.EACCES),
    (FileNotFoundError("x"), errno.ENOENT),
    (ValueError("no mount at /x"), errno.ENOENT),
])
def test_exception_class_wins(err, expected):
    assert classify_error(err) == expected


def test_errno_carrying_oserror_uses_its_errno():
    err = OSError(errno.ENOTEMPTY, os.strerror(errno.ENOTEMPTY), "/d")
    assert classify_error(err) == errno.ENOTEMPTY


def test_bare_oserror_falls_back_to_the_message():
    # ram/redis/databricks rmdir raise a bare OSError with no errno set.
    assert classify_error(
        OSError("directory not empty: /d")) == errno.ENOTEMPTY


def test_missing_path_in_rmdir_is_enoent_not_enotempty():
    # FileNotFoundError subclasses OSError, so an `except OSError` arm placed
    # before the FileNotFoundError arm used to map a missing rmdir target to
    # ENOTEMPTY. Class dispatch fixes that ordering hazard for good.
    assert classify_error(FileNotFoundError("no such file")) == errno.ENOENT


def test_unrecognised_error_is_eio():
    assert classify_error(RuntimeError("something else entirely")) == errno.EIO


def test_message_matching_is_case_insensitive():
    assert classify_error(Exception("Permission Denied")) == errno.EACCES


def test_no_xattr_is_platform_appropriate():
    assert NO_XATTR in (getattr(errno, "ENOATTR", None), errno.ENODATA)
