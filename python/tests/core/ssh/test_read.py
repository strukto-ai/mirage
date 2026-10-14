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

import pytest

from mirage.core.ssh.read import line_count
from mirage.types import PathSpec
from tests.fixtures.ssh_run import RunAccessor


def _file(vfs_path: str) -> PathSpec:
    virtual = "/s/" + vfs_path
    return PathSpec(
        virtual=virtual, directory="/s", vfs_path=vfs_path, raw_path=virtual
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("out", [b"42\n", b"     42\n"])
async def test_line_count_is_what_wc_counts(out):
    accessor = RunAccessor("data", (0, out, b""))
    assert await line_count(accessor, _file("a b.txt")) == 42
    assert accessor.sent == ["env LC_ALL=C wc -l < 'data/a b.txt'"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        (1, b"", b"wc: 'standard input': Is a directory\n"),
        (1, b"", b"sh: data/x: No such file or directory\n"),
        (0, b"3\n", b"warning\n"),
        (0, b"3", b""),
        (0, b"3 x\n", b""),
        (127, b"", b"only the mount's own commands run here\n"),
        OSError("closed"),
    ],
)
async def test_anything_but_one_count_leaves_the_read(answer):
    assert await line_count(RunAccessor("data", answer), _file("x")) is None
