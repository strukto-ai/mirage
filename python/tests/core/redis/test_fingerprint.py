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

from mirage.accessor.redis import RedisAccessor
from mirage.core.redis.fingerprint import token_of
from mirage.core.redis.readdir import tree
from mirage.core.redis.stat import stat
from mirage.core.redis.write import write
from mirage.types import FileStat, PathSpec
from mirage.utils.clock import ManualClock, run_with_system_clock


def at(p: str) -> PathSpec:
    return PathSpec.from_str_path(p)


def test_a_file_no_write_dated_has_none():
    assert token_of(None) is None


async def _rewritten(
    accessor: RedisAccessor,
) -> tuple[FileStat, FileStat, FileStat]:
    await write(accessor, at("/f"), b"one")
    first = await stat(accessor, at("/f"))
    await write(accessor, at("/f"), b"two")
    second = await stat(accessor, at("/f"))
    rows = await tree(accessor, at("/"))
    assert rows is not None
    return first, second, rows["f"]


@pytest.mark.asyncio
async def test_a_same_size_rewrite_moves_it_on_a_clock_that_stands_still(
    store,
):
    first, second, listed = await run_with_system_clock(
        ManualClock(1_800_000_000), _rewritten(store)
    )
    assert first.fingerprint != second.fingerprint
    assert listed.fingerprint == second.fingerprint
