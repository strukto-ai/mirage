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

import hashlib

import pytest

from mirage.commands.builtin.generic.shuf import shuf_generic
from mirage.utils.ids import SeededIdSource

# Pinned by shuf.test.ts too: one seed shuffles the same way on both
# hosts.
CASES = [
    ({"input_range": "1-1000", "count": 5}, [], "263\n510\n609\n684\n499\n"),
    (
        {"input_range": "1-18446744073709551615", "count": 3},
        [],
        "11217175675983945601\n2690887512640883574\n14695936735223002468\n",
    ),
    ({"echo": True}, ["a", "b", "c", "d", "e"], "d\na\nc\nb\ne\n"),
    (
        {"echo": True, "with_replacement": True, "count": 4},
        ["a", "b", "c", "d", "e"],
        "e\ne\nb\ne\n",
    ),
]
STDIN = b"1\n2\n3\n4\n5\n6\n"


async def _read_operand(*_):
    raise AssertionError("shuf read an operand it was not given")


async def _text(out) -> str:
    if isinstance(out, bytes):
        return out.decode()
    return b"".join([chunk async for chunk in out]).decode()


@pytest.mark.asyncio
@pytest.mark.parametrize("options,texts,expected", CASES)
async def test_shuf_draws_from_the_id_source(options, texts, expected):
    for _ in range(2):
        out, io = await shuf_generic(
            [],
            texts,
            read_bytes=_read_operand,
            ids=SeededIdSource(5),
            **options,
        )
        assert io.exit_code == 0
        assert await _text(out) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options,expected",
    [
        ({}, "4\n1\n3\n2\n6\n5\n"),
        ({"with_replacement": True, "count": 4}, "5\n5\n2\n5\n"),
    ],
)
async def test_shuf_draws_records_from_the_id_source(options, expected):
    out, io = await shuf_generic(
        [],
        [],
        read_bytes=_read_operand,
        stdin=STDIN,
        ids=SeededIdSource(5),
        **options,
    )
    assert io.exit_code == 0
    assert await _text(out) == expected


# Past the spool's memory limit, so a shuffle scatters into buckets and
# a draw with replacement reads records back from disk.
LARGE = b"".join(b"%07d\n" % n for n in range(300_000))


async def _chunks(data: bytes, size: int):
    for start in range(0, len(data), size):
        yield data[start : start + size]


async def _digest(out) -> str:
    digest = hashlib.sha256()
    async for chunk in out:
        digest.update(chunk)
    return digest.hexdigest()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options,expected,after",
    [
        (
            {},
            "8eb383374346a93ffbbdeb29edbebeccd4192ff7d4262267e4498ebf05d1a933",
            2601269980,
        ),
        (
            {"with_replacement": True, "count": 1000},
            "fb6124666c6999dbdc514f28a0023b37539fbe8a53a76be4816802053f86427a",
            2616697384,
        ),
    ],
)
@pytest.mark.parametrize("chunk", [4096, 65537])
async def test_shuf_replays_past_the_memory_limit(
    options, expected, after, chunk
):
    # Pinned by shuf.test.ts too, with the draw that follows, so a host
    # that drew once more or once less than the other shows here.
    ids = SeededIdSource(5)
    out, io = await shuf_generic(
        [],
        [],
        read_bytes=_read_operand,
        stdin=_chunks(LARGE, chunk),
        ids=ids,
        **options,
    )
    assert io.exit_code == 0
    assert await _digest(out) == expected
    assert ids.random_u32() == after
