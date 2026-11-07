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

from mirage.commands.builtin.utils.random_source import (
    RandomSource,
    RandomSourceError,
)
from mirage.types import PathSpec

SOURCE = PathSpec.from_str_path("/r")


def _reader(data: bytes, size: int = 3):
    async def stream(path):
        for at in range(0, len(data), size):
            yield data[at : at + size]

    return stream


def _failing(exc: OSError):
    async def stream(path):
        raise exc
        yield b""

    return stream


@pytest.mark.asyncio
async def test_bytes_come_out_in_order_across_chunks():
    source = RandomSource("shuf", SOURCE, _reader(b"abcdefgh"))
    assert await source.take(2) == b"ab"
    assert await source.take(4) == b"cdef"
    assert await source.take(2) == b"gh"
    await source.close()


@pytest.mark.asyncio
async def test_a_source_nothing_draws_from_is_never_opened():
    opened: list[PathSpec] = []

    def stream(path):
        opened.append(path)
        return _reader(b"")(path)

    await RandomSource("shuf", SOURCE, stream).close()
    assert opened == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stream, opening, message",
    [
        (_reader(b"ab"), None, "sort: '/r': end of file"),
        (
            _failing(IsADirectoryError(21, "Is a directory")),
            None,
            "shuf: '/r': read error: Is a directory",
        ),
        (
            _failing(FileNotFoundError(2, "No such file or directory")),
            "open failed",
            "sort: open failed: /r: No such file or directory",
        ),
        (
            _failing(FileNotFoundError(2, "No such file or directory")),
            None,
            "shuf: /r: No such file or directory",
        ),
    ],
)
async def test_a_source_that_cannot_hand_out_the_bytes(
    stream, opening, message
):
    cmd = message.split(":", 1)[0]
    source = RandomSource(cmd, SOURCE, stream, opening=opening)
    with pytest.raises(RandomSourceError) as caught:
        await source.take(4)
    assert str(caught.value) == message
