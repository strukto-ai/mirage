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

from mirage.core.ram.fingerprint import token_of
from mirage.types import FileStat, PathSpec
from mirage.utils.clock import ManualClock, run_with_system_clock
from mirage.vfs.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore


def at(p: str) -> PathSpec:
    return PathSpec.from_str_path(p)


def test_a_file_no_write_dated_has_none():
    assert token_of(RAMStore(), "/f") is None


async def _rewritten(vfs: RAMVFS) -> tuple[FileStat, FileStat, FileStat]:
    await vfs.write(at("/f"), b"one")
    first = await vfs.stat(at("/f"))
    await vfs.write(at("/f"), b"two")
    second = await vfs.stat(at("/f"))
    tree = await vfs.read_tree(at("/"))
    assert tree is not None
    return first, second, tree["f"]


@pytest.mark.asyncio
async def test_a_same_size_rewrite_moves_it_on_a_clock_that_stands_still():
    first, second, listed = await run_with_system_clock(
        ManualClock(1_800_000_000), _rewritten(RAMVFS())
    )
    assert first.fingerprint != second.fingerprint
    assert listed.fingerprint == second.fingerprint
