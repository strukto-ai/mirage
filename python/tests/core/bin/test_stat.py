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
from mirage.core.bin.render import render_stub
from mirage.core.bin.stat import stat
from mirage.types import FileType, PathSpec


def _accessor() -> BinAccessor:
    return BinAccessor(
        lambda: ["ls"],
        lambda n: "ls is built into mirage." if n == "ls" else None,
        "2026-11-18T10:00:00Z",
    )


def _spec(path: str) -> PathSpec:
    return PathSpec(
        virtual=path, directory=path, vfs_path=path.removeprefix("/usr/bin")
    )


@pytest.mark.asyncio
async def test_stat_a_program_is_an_executable_file_sized_to_its_stub():
    st = await stat(_accessor(), _spec("/usr/bin/ls"))
    assert st.type is FileType.FILE
    assert st.mode == 0o755
    assert st.size == len(render_stub("ls", "ls is built into mirage."))
    assert st.modified == "2026-11-18T10:00:00Z"
    assert st.nlink == 1


@pytest.mark.asyncio
async def test_stat_the_view_root_is_a_directory_and_a_miss_is_enoent():
    root = await stat(_accessor(), _spec("/usr/bin"))
    assert root.type is FileType.DIRECTORY
    assert root.modified == "2026-11-18T10:00:00Z"
    assert root.nlink == 2
    with pytest.raises(FileNotFoundError):
        await stat(_accessor(), _spec("/usr/bin/cd"))
