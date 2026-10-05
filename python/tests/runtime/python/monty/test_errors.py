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

import pytest

from mirage.errors.types import FsCondition
from mirage.runtime.python.monty.errors import cpython_error


def test_every_condition_renders_as_a_python_oserror():
    # A condition cannot be half-added: every member of the vocabulary
    # renders, under a real builtin a guest can `except`.
    for cond in FsCondition:
        exc = getattr(builtins, cpython_error(cond).exception)
        assert issubclass(exc, OSError)


@pytest.mark.parametrize(
    "cond,exception,number,phrase",
    [
        (
            FsCondition.ENOENT,
            "FileNotFoundError",
            2,
            "No such file or directory",
        ),
        (FsCondition.ENOTDIR, "NotADirectoryError", 20, "Not a directory"),
        (FsCondition.EISDIR, "IsADirectoryError", 21, "Is a directory"),
        (FsCondition.EEXIST, "FileExistsError", 17, "File exists"),
        (FsCondition.EACCES, "PermissionError", 13, "Permission denied"),
        (FsCondition.EPERM, "PermissionError", 1, "Operation not permitted"),
        (FsCondition.EXDEV, "OSError", 18, "Invalid cross-device link"),
        (FsCondition.ENOTEMPTY, "OSError", 39, "Directory not empty"),
        (
            FsCondition.ELOOP,
            "OSError",
            40,
            "Too many levels of symbolic links",
        ),
        (FsCondition.NO_XATTR, "OSError", 61, "No data available"),
    ],
)
def test_rows_are_cpython_on_linux(cond, exception, number, phrase):
    # A guest interpreter is platform-neutral, so neither its numbering
    # nor its wording wobbles with the host: on macOS ELOOP is 62 and
    # "attribute not set" is ENOATTR, "Attribute not found".
    row = cpython_error(cond)
    assert (row.exception, row.errno, row.phrase) == (
        exception,
        number,
        phrase,
    )
