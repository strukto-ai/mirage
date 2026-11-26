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

from mirage.commands.builtin.generic.head import head_multi
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _paths(*names: str) -> list[PathSpec]:
    return [
        PathSpec(
            vfs_path=mount_key(n, ""), virtual=n, directory="/d", resolved=True
        )
        for n in names
    ]


async def _collect(gen) -> bytes:
    out = b""
    async for chunk in gen:
        out += chunk
    return out


_CHUNKS = {"/a": [b"a1\n", b"a2\n"], "/b": [b"b1\n"]}


async def _read_bytes(p: PathSpec) -> bytes:
    return b"".join(_CHUNKS[p.virtual])


def _read_stream(p: PathSpec):
    async def gen():
        for chunk in _CHUNKS[p.virtual]:
            yield chunk

    return gen()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "read,n,expected",
    [
        (_read_bytes, 1, b"==> /a <==\na1\n\n==> /b <==\nb1\n"),
        (_read_stream, 5, b"==> /a <==\na1\na2\n\n==> /b <==\nb1\n"),
    ],
)
async def test_head_multi_takes_a_bytes_or_a_stream_reader(read, n, expected):
    out = await _collect(
        head_multi(_paths("/a", "/b"), read=read, n=n, show_headers=True)
    )
    assert out == expected
