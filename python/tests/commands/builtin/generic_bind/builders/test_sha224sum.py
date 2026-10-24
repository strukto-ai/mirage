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


async def _sha224sum(vfs: StoredRAM, line: str) -> str:
    ws = Workspace({"/m/": vfs}, mode=MountMode.WRITE)
    await (await ws.shell("printf abc > /m/f")).materialize_stdout()
    io = await ws.shell(line)
    return (await io.materialize_stdout()).decode()


@pytest.mark.asyncio
async def test_sha224sum_asks_the_mount_for_sha224():
    vfs = StoredRAM(None)
    out = await _sha224sum(vfs, "sha224sum /m/f")
    assert vfs.asked == ["sha224"]
    assert out == f"{hashlib.sha224(b'abc').hexdigest()}  /m/f\n"


@pytest.mark.asyncio
async def test_sha224sum_prints_a_stored_digest_without_reading():
    out = await _sha224sum(StoredRAM("cd" * 28), "sha224sum --tag /m/f")
    assert out == f"SHA224 (/m/f) = {'cd' * 28}\n"
