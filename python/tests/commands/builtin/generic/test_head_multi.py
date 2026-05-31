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


def _paths(*names: str) -> list[PathSpec]:
    return [
        PathSpec(original=n, directory="/d", prefix="", resolved=True)
        for n in names
    ]


async def _collect(gen) -> bytes:
    out = b""
    async for chunk in gen:
        out += chunk
    return out


@pytest.mark.asyncio
async def test_head_multi_bytes_reader_no_headers():
    data = {"/a": b"a1\na2\na3\n", "/b": b"b1\nb2\n"}

    async def read(accessor, p, index):
        return data[p.original]

    out = await _collect(
        head_multi(_paths("/a", "/b"), read=read, n=1, show_headers=False))
    assert out == b"a1\nb1\n"


@pytest.mark.asyncio
async def test_head_multi_with_headers():
    data = {"/a": b"a1\na2\n", "/b": b"b1\nb2\n"}

    async def read(accessor, p, index):
        return data[p.original]

    out = await _collect(
        head_multi(_paths("/a", "/b"), read=read, n=1, show_headers=True))
    assert out == b"==> /a <==\na1\n\n==> /b <==\nb1\n"


@pytest.mark.asyncio
async def test_head_multi_stream_reader():
    chunks = {"/a": [b"a1\n", b"a2\n"], "/b": [b"b1\n"]}

    def read(accessor, p, index):

        async def gen():
            for ch in chunks[p.original]:
                yield ch

        return gen()

    out = await _collect(
        head_multi(_paths("/a", "/b"), read=read, n=5, show_headers=True))
    assert out == b"==> /a <==\na1\na2\n\n==> /b <==\nb1\n"
