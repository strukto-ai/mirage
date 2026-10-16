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

from mirage.core.ssh.checksum import checksum
from mirage.types import PathSpec
from tests.fixtures.ssh_run import RunAccessor

SHA256 = "a" * 64


def _file(vfs_path: str) -> PathSpec:
    virtual = "/s/" + vfs_path
    return PathSpec(
        virtual=virtual, directory="/s", vfs_path=vfs_path, raw_path=virtual
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("algorithm", "tool", "digest"),
    [
        ("md5", "md5sum", "0" * 32),
        ("sha1", "sha1sum", "1" * 40),
        ("sha256", "sha256sum", SHA256),
        ("sha384", "sha384sum", "3" * 96),
        ("sha512", "sha512sum", "5" * 128),
    ],
)
async def test_the_digest_is_what_the_servers_sum_prints(
    algorithm, tool, digest
):
    accessor = RunAccessor("data", (0, f"{digest}  -\n".encode(), b""))
    assert await checksum(accessor, _file("a b.txt"), algorithm) == digest
    assert accessor.sent == [f"{tool} < 'data/a b.txt'"]


@pytest.mark.asyncio
async def test_an_algorithm_with_no_tool_is_read_without_a_command():
    accessor = RunAccessor("data", (0, b"", b""))
    assert await checksum(accessor, _file("x"), "blake2b") is None
    assert accessor.sent == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        (1, b"", b"sha256sum: -: Is a directory\n"),
        (1, b"", b"sh: data/x: No such file or directory\n"),
        (0, f"{SHA256}  -\n".encode(), b"warning\n"),
        (0, f"{SHA256} *-\n".encode(), b""),
        (0, f"{SHA256}  -".encode(), b""),
        (0, f"{SHA256[:-1]}  -\n".encode(), b""),
        (0, f"{SHA256[:-1]}G  -\n".encode(), b""),
        (0, f"{SHA256.upper()}  -\n".encode(), b""),
        (127, b"", b"only the mount's own commands run here\n"),
        OSError("closed"),
    ],
)
async def test_anything_but_one_digest_leaves_the_read(answer):
    accessor = RunAccessor("data", answer)
    assert await checksum(accessor, _file("x"), "sha256") is None
