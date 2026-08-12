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

from mirage.errors.guest import GUEST, guest_seat
from mirage.errors.posix import POSIX
from mirage.errors.types import FsCondition


def test_every_exception_name_is_a_real_python_builtin():
    for seat in GUEST.values():
        exc = getattr(builtins, seat.name)
        assert issubclass(exc, OSError)


@pytest.mark.parametrize("cond,name,number", [
    (FsCondition.ENOENT, "FileNotFoundError", 2),
    (FsCondition.ENOTDIR, "NotADirectoryError", 20),
    (FsCondition.EISDIR, "IsADirectoryError", 21),
    (FsCondition.EEXIST, "FileExistsError", 17),
    (FsCondition.EACCES, "PermissionError", 13),
    (FsCondition.EPERM, "PermissionError", 1),
    (FsCondition.EXDEV, "OSError", 18),
    (FsCondition.CROSS_MOUNT, "OSError", 18),
    (FsCondition.ENOTEMPTY, "OSError", 39),
    (FsCondition.ELOOP, "OSError", 40),
])
def test_guest_rows_are_cpython_on_linux(cond, name, number):
    # A guest interpreter is platform-neutral, so its numbering must not
    # wobble with the host: the rows pin CPython-on-Linux errnos, the
    # numbering monty's TypeScript twin already used for its six codes.
    seat = guest_seat(cond)
    assert (seat.name, seat.errno) == (name, number)


def test_phrases_match_the_posix_table():
    # One phrase per condition, not one per boundary: the guest message
    # is CPython's, which is GNU strerror's. NO_XATTR is exempt because
    # the posix seat resolves per platform (macOS "Attribute not found")
    # while a guest interpreter always speaks Linux.
    for cond in FsCondition:
        if cond is FsCondition.NO_XATTR:
            continue
        assert GUEST[cond].phrase == POSIX[cond].phrase
