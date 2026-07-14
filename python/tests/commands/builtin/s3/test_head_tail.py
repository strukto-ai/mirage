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

from mirage.accessor.s3 import S3Accessor
from mirage.commands.builtin.generic_bind.adapter import CommandIO
from mirage.commands.builtin.generic_bind.builders.head import head
from mirage.commands.builtin.generic_bind.builders.tail import tail
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _ops(chunks):

    async def stat(accessor, path, index=None):
        if path.virtual not in chunks:
            raise FileNotFoundError(path.virtual)
        return {"size": 0}

    return CommandIO(readdir=None,
                     read_bytes=None,
                     read_stream=_streamer(chunks),
                     stat=stat,
                     is_mounted=lambda a: True,
                     local=False)


def _paths(*names: str) -> list[PathSpec]:
    return [
        PathSpec(resource_path=mount_key(n, ""),
                 virtual=n,
                 directory="/data",
                 resolved=True) for n in names
    ]


async def _collect(out) -> bytes:
    if isinstance(out, bytes):
        return out
    data = b""
    async for chunk in out:
        data += chunk
    return data


def _streamer(chunks_by_path):

    def read_stream(accessor, path, index=None):

        async def gen():
            for ch in chunks_by_path[path.virtual]:
                yield ch

        return gen()

    return read_stream


@pytest.mark.asyncio
async def test_head_multi_streaming_with_headers():
    chunks = {
        "/data/a.txt": [b"a1\n", b"a2\na3\n"],
        "/data/b.txt": [b"b1\nb2\n"],
    }
    acc = S3Accessor.__new__(S3Accessor)
    out, _ = await head(_ops(chunks),
                        acc,
                        _paths("/data/a.txt", "/data/b.txt"),
                        n="2")
    data = await _collect(out)
    assert data == (b"==> /data/a.txt <==\na1\na2\n"
                    b"\n==> /data/b.txt <==\nb1\nb2\n")


@pytest.mark.asyncio
async def test_tail_multi_streaming_with_headers():
    chunks = {
        "/data/a.txt": [b"a1\na2\n", b"a3\n"],
        "/data/b.txt": [b"b1\nb2\nb3\n"],
    }
    acc = S3Accessor.__new__(S3Accessor)
    out, _ = await tail(_ops(chunks),
                        acc,
                        _paths("/data/a.txt", "/data/b.txt"),
                        n="2")
    data = await _collect(out)
    assert data == (b"==> /data/a.txt <==\na2\na3\n"
                    b"\n==> /data/b.txt <==\nb2\nb3\n")
