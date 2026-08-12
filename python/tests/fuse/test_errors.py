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
from mirage.runtime.errors import CrossMountError
from mirage.utils.errors import no_mount
from mirage.utils.path import CycleError


@pytest.mark.parametrize("err,expected", [
    (NotADirectoryError("x"), errno.ENOTDIR),
    (IsADirectoryError("x"), errno.EISDIR),
    (FileExistsError("x"), errno.EEXIST),
    (PermissionError("x"), errno.EACCES),
    (FileNotFoundError("x"), errno.ENOENT),
    (no_mount("/x"), errno.ENOENT),
])
def test_exception_class_wins(err, expected):
    assert classify_error(err) == expected


def test_bare_valueerror_is_a_refusal_not_a_miss():
    # An oversized postgres read and a databricks rename into the
    # source's own subtree both raise bare ValueError; reporting those
    # ENOENT would call an existing object absent. Only the registry's
    # typed miss is one, so this falls to the EIO backstop.
    assert classify_error(ValueError("row too large to render")) == errno.EIO


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


def test_symlink_loop_is_eloop_not_eio():
    # CycleError is documented as POSIX ELOOP and raised as
    # CycleError(path), so no needle can match its message. Before the
    # shared vocabulary it fell through every arm and a symlink loop
    # reached the kernel as "Input/output error".
    assert classify_error(CycleError("/a")) == errno.ELOOP


def test_cross_mount_rename_is_exdev():
    # EXDEV is what tells the kernel "not one filesystem", which is what
    # makes mv fall back to copy+unlink over a FUSE mount.
    assert classify_error(CrossMountError("/a/x", "/b/x")) == errno.EXDEV


def test_message_matching_is_case_insensitive():
    assert classify_error(Exception("Permission Denied")) == errno.EACCES


def test_no_xattr_is_platform_appropriate():
    assert NO_XATTR in (getattr(errno, "ENOATTR", None), errno.ENODATA)
