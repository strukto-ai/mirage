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

from mirage.types import PathSpec
from mirage.utils.errors import (OperationNotSupportedError, enoent, enotdir,
                                 enotsup, format_fs_error, fs_strerror)


def test_fs_strerror_known_types():
    assert fs_strerror(FileNotFoundError()) == "No such file or directory"
    assert fs_strerror(NotADirectoryError()) == "Not a directory"
    assert fs_strerror(IsADirectoryError()) == "Is a directory"
    assert fs_strerror(FileExistsError()) == "File exists"
    assert fs_strerror(PermissionError()) == "Permission denied"
    assert (fs_strerror(
        OperationNotSupportedError()) == "Operation not supported")


def test_fs_strerror_unknown_returns_none():
    assert fs_strerror(ValueError("nope")) is None


def test_enoent_uses_virtual_path():
    spec = PathSpec.from_str_path("/a/missing.txt")
    exc = enoent(spec)
    assert isinstance(exc, FileNotFoundError)
    assert str(exc) == "/a/missing.txt"


def test_enotdir_accepts_plain_string():
    exc = enotdir("/a/file.txt/x")
    assert isinstance(exc, NotADirectoryError)
    assert str(exc) == "/a/file.txt/x"


def test_format_fs_error_appends_strerror():
    err = format_fs_error("cat", enoent("/b/missing.txt"))
    assert err == b"cat: /b/missing.txt: No such file or directory\n"


def test_format_fs_error_rewrites_to_raw_path():
    spec = PathSpec(virtual="/a/missing.txt",
                    directory="/a/",
                    resource_path="missing.txt",
                    raw_path="missing.txt")
    err = format_fs_error("diff", enoent("/a/missing.txt"), [spec])
    assert err == b"diff: missing.txt: No such file or directory\n"


def test_format_fs_error_prefers_exc_filename():
    exc = FileNotFoundError(2, "No such file or directory", "/a/gone.txt")
    err = format_fs_error("head", exc)
    assert err == b"head: /a/gone.txt: No such file or directory\n"


def test_enotsup_carries_op_and_operand():
    spec = PathSpec.from_str_path("/mail/inbox/a.txt")
    exc = enotsup("email", "unlink", spec)
    assert isinstance(exc, OperationNotSupportedError)
    assert exc.errno == errno.ENOTSUP
    assert exc.filename == "/mail/inbox/a.txt"
    assert "no op 'unlink'" in str(exc)


def test_format_fs_error_enotsup_reports_operand():
    err = format_fs_error("mv", enotsup("email", "unlink", "/mail/a.txt"))
    assert err == b"mv: /mail/a.txt: Operation not supported\n"
