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

from mirage.core.ssh.stream import follow
from mirage.types import PathSpec
from tests.fixtures.ssh_run import StreamAccessor


def _file(vfs_path: str) -> PathSpec:
    virtual = "/s/" + vfs_path
    return PathSpec(
        virtual=virtual, directory="/s", vfs_path=vfs_path, raw_path=virtual
    )


@pytest.mark.asyncio
async def test_follow_streams_what_the_servers_tail_prints():
    accessor = StreamAccessor("data", [b"\nb\nc\n", b"d\n", b"e"])
    stream = await follow(accessor, _file("a b.txt"), 2, 1.0)
    assert stream is not None
    assert [chunk async for chunk in stream] == [b"b\nc\n", b"d\n", b"e"]
    assert accessor.sent == [
        "test -f 'data/a b.txt' && test -r 'data/a b.txt'"
        " && command -v tail >/dev/null"
        " && echo && exec tail -n 2 -f -- 'data/a b.txt'"
    ]
    assert accessor.closed == 1


@pytest.mark.asyncio
async def test_a_follow_the_caller_stops_closes_the_command():
    accessor = StreamAccessor("data", [b"\n", b"x\n", b"y\n"])
    stream = await follow(accessor, _file("a"), 0, 1.0)
    assert stream is not None
    assert await anext(stream) == b"x\n"
    await stream.aclose()
    assert accessor.closed == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "chunks",
    [
        [],
        [b"This service allows sftp connections only.\n"],
        OSError("closed"),
    ],
)
async def test_anything_but_the_shells_empty_line_leaves_the_poll(chunks):
    accessor = StreamAccessor("data", chunks)
    assert await follow(accessor, _file("a"), 1, 1.0) is None
    if not isinstance(chunks, Exception):
        assert accessor.closed == 1
