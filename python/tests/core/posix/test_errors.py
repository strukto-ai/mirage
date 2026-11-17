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

from mirage.core.posix.errors import refusal
from mirage.types import PathSpec

PATH = PathSpec.from_str_path("/tmp/x")


@pytest.mark.parametrize(
    ("said", "code"),
    [
        (b"cat: /tmp/x: No such file or directory\n", errno.ENOENT),
        (b"mv: cannot stat 'a': Not a directory\n", errno.ENOTDIR),
        (b"rm: cannot remove 'x': Permission denied\nmore\n", errno.EACCES),
        (
            b"sh: 1: cannot create /tmp/x: Directory nonexistent\n",
            errno.ENOENT,
        ),
        (b"something else\n", errno.EIO),
        (b"", errno.EIO),
    ],
)
def test_refusal_reads_the_first_complaint(said, code):
    exc = refusal(PATH, said)
    assert (exc.errno, exc.filename) == (code, "/tmp/x")
