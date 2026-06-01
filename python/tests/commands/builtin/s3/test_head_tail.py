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

import importlib

import pytest

from mirage.accessor.s3 import S3Accessor
from mirage.types import PathSpec

s3_head = importlib.import_module("mirage.commands.builtin.s3.head")
s3_tail = importlib.import_module("mirage.commands.builtin.s3.tail")


def _paths(*names: str) -> list[PathSpec]:
    return [
        PathSpec(original=n, directory="/data", prefix="", resolved=True)
        for n in names
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
            for ch in chunks_by_path[path.original]:
                yield ch

        return gen()

    return read_stream


@pytest.mark.asyncio
async def test_head_multi_streaming_with_headers(monkeypatch):
    chunks = {
        "/data/a.txt": [b"a1\n", b"a2\na3\n"],
        "/data/b.txt": [b"b1\nb2\n"],
    }

    async def fake_resolve_glob(accessor, paths, index=None):
        return paths

    monkeypatch.setattr(s3_head, "resolve_glob", fake_resolve_glob)
    monkeypatch.setattr(s3_head, "read_stream", _streamer(chunks))

    acc = S3Accessor.__new__(S3Accessor)
    out, _ = await s3_head.head(acc,
                                _paths("/data/a.txt", "/data/b.txt"),
                                n="2")
    data = await _collect(out)
    assert data == (b"==> /data/a.txt <==\na1\na2\n"
                    b"\n==> /data/b.txt <==\nb1\nb2\n")


@pytest.mark.asyncio
async def test_tail_multi_streaming_with_headers(monkeypatch):
    chunks = {
        "/data/a.txt": [b"a1\na2\n", b"a3\n"],
        "/data/b.txt": [b"b1\nb2\nb3\n"],
    }

    async def fake_resolve_glob(accessor, paths, index=None):
        return paths

    monkeypatch.setattr(s3_tail, "resolve_glob", fake_resolve_glob)
    monkeypatch.setattr(s3_tail, "read_stream", _streamer(chunks))

    acc = S3Accessor.__new__(S3Accessor)
    out, _ = await s3_tail.tail(acc,
                                _paths("/data/a.txt", "/data/b.txt"),
                                n="2")
    data = await _collect(out)
    assert data == (b"==> /data/a.txt <==\na2\na3\n"
                    b"\n==> /data/b.txt <==\nb2\nb3\n")
