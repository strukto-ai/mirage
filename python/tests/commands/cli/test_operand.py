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

from mirage.commands.cli.operand import ensure_dir, first_text, read_operand
from mirage.types import PathSpec


def _path(value: str) -> PathSpec:
    return PathSpec.from_str_path(value)


class _Files:
    def __init__(self, known: set[str]) -> None:
        self.known = known
        self.created: list[str] = []

    async def read(self, path: PathSpec) -> bytes:
        if path.virtual not in self.known:
            raise FileNotFoundError(path.virtual)
        return b"data"

    async def stat(self, path: PathSpec) -> None:
        if path.virtual not in self.known:
            raise FileNotFoundError(path.virtual)

    async def mkdir(self, path: PathSpec) -> None:
        if path.virtual == "/a/race":
            raise FileExistsError(path.virtual)
        self.created.append(path.virtual)


def test_first_text_refuses_nothing():
    assert first_text(["x"], "id") == "x"
    with pytest.raises(ValueError, match="id is required"):
        first_text([""], "id")


@pytest.mark.asyncio
async def test_read_operand_needs_a_workspace():
    with pytest.raises(ValueError, match="--file needs a workspace"):
        await read_operand(None, _path("/a"), "--file")


@pytest.mark.asyncio
async def test_read_operand_names_a_missing_file():
    files = _Files({"/a"})
    assert await read_operand(files, _path("/a"), "--file") == b"data"
    with pytest.raises(ValueError, match="read /b: No such file"):
        await read_operand(files, _path("/b"), "--file")


@pytest.mark.asyncio
async def test_ensure_dir_creates_parents_first():
    files = _Files({"/a"})
    await ensure_dir(files, _path("/a/b/c"))
    assert files.created == ["/a/b", "/a/b/c"]


@pytest.mark.asyncio
async def test_ensure_dir_tolerates_a_lost_race():
    files = _Files({"/a"})
    await ensure_dir(files, _path("/a/race"))
    assert files.created == []
