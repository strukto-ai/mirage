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

from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


class StoredRAM(RAMVFS):
    def __init__(self, stored: str | None) -> None:
        super().__init__()
        self.stored = stored
        self.asked: list[str] = []

    async def checksum(self, path: PathSpec, algorithm: str) -> str | None:
        self.asked.append(algorithm)
        return self.stored


async def _b2sum(vfs: StoredRAM, line: str) -> str:
    ws = Workspace({"/m/": vfs}, mode=MountMode.WRITE)
    await (await ws.shell("printf abc > /m/f")).materialize_stdout()
    io = await ws.shell(line)
    return (await io.materialize_stdout()).decode()


@pytest.mark.asyncio
async def test_b2sum_asks_the_mount_for_its_length():
    vfs = StoredRAM(None)
    out = await _b2sum(vfs, "b2sum -l 256 /m/f; b2sum /m/f")
    assert vfs.asked == ["blake2b-256", "blake2b"]
    assert out == (
        f"{hashlib.blake2b(b'abc', digest_size=32).hexdigest()}  /m/f\n"
        f"{hashlib.blake2b(b'abc').hexdigest()}  /m/f\n"
    )


@pytest.mark.asyncio
async def test_b2sum_prints_a_stored_digest_without_reading():
    out = await _b2sum(StoredRAM("ab" * 64), "b2sum /m/f")
    assert out == f"{'ab' * 64}  /m/f\n"
