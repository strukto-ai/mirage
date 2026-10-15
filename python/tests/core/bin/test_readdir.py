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

from mirage.accessor.bin import BinAccessor
from mirage.core.bin.readdir import readdir
from mirage.core.bin.stat import stat
from mirage.types import PathSpec


def _accessor() -> BinAccessor:
    return BinAccessor(
        lambda: ["cat", "ls"],
        lambda n: f"{n} is built into mirage." if n in ("cat", "ls") else None,
    )


def _spec(path: str) -> PathSpec:
    return PathSpec(
        virtual=path, directory=path, vfs_path=path.removeprefix("/usr/bin")
    )


@pytest.mark.asyncio
async def test_readdir_lists_one_row_per_program_as_its_stat():
    accessor = _accessor()
    rows = await readdir(accessor, _spec("/usr/bin"))
    assert [row.name for row in rows] == ["cat", "ls"]
    assert rows[1] == await stat(accessor, _spec("/usr/bin/ls"))


@pytest.mark.asyncio
async def test_readdir_of_a_program_is_not_a_directory():
    with pytest.raises(NotADirectoryError):
        await readdir(_accessor(), _spec("/usr/bin/ls"))
    with pytest.raises(FileNotFoundError):
        await readdir(_accessor(), _spec("/usr/bin/cd"))
