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

from collections.abc import AsyncIterator

import pytest

from mirage.commands.builtin.utils.safeguard import apply_safeguard
from mirage.commands.safeguard import CommandSafeguard
from mirage.io.types import materialize
from mirage.types import OnExceed

_TEN = b"".join(f"line{i}\n".encode() for i in range(10))


async def _stream(data: bytes) -> AsyncIterator[bytes]:
    for i in range(0, len(data), 7):
        yield data[i:i + 7]


@pytest.mark.asyncio
async def test_no_safeguard_passthrough():
    out, io = await apply_safeguard(_TEN, None)
    assert out == _TEN and io.exit_code == 0 and io.stderr is None


@pytest.mark.asyncio
async def test_under_limit_not_truncated():
    sg = CommandSafeguard(max_lines=100)
    out, io = await apply_safeguard(_TEN, sg)
    assert out == _TEN and io.stderr is None


@pytest.mark.asyncio
async def test_truncate_by_lines():
    sg = CommandSafeguard(max_lines=3)
    out, io = await apply_safeguard(_TEN, sg)
    assert out == b"line0\nline1\nline2\n"
    assert io.exit_code == 0
    assert b"truncated" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_error_by_lines():
    sg = CommandSafeguard(max_lines=3, on_exceed=OnExceed.ERROR)
    out, io = await apply_safeguard(_TEN, sg)
    assert out is None
    assert io.exit_code == 1
    assert b"truncated" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_truncate_by_bytes():
    sg = CommandSafeguard(max_bytes=10)
    out, io = await apply_safeguard(_TEN, sg)
    assert out == _TEN[:10]
    assert b"truncated" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_streaming_input_truncates_and_stops_early():
    sg = CommandSafeguard(max_lines=2)
    out, io = await apply_safeguard(_stream(_TEN), sg)
    assert out == b"line0\nline1\n"
    assert b"truncated" in (await materialize(io.stderr))
