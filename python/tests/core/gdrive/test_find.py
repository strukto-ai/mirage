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

from mirage.core.gdrive.find import find
from mirage.types import PathSpec

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


def seed_tree(fake_drive) -> None:
    sub = fake_drive.folder("sub")
    fake_drive.add("a.txt", content=b"aaaa")
    fake_drive.add("big.bin", parent=sub, content=b"x" * 2048)
    fake_drive.add("small.bin", parent=sub, content=b"x" * 16)
    fake_drive.add("Report", mime=DOC_MIME)


@pytest.mark.asyncio
async def test_find_lists_subtree_sorted(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    out = await find(gdrive_accessor, spec("/sub"))
    assert out == ["/sub", "/sub/big.bin", "/sub/small.bin"]


@pytest.mark.asyncio
async def test_find_name_matches_native_suffix(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    out = await find(gdrive_accessor, spec("/"), name="*.gdoc.json")
    assert out == ["/Report.gdoc.json"]


@pytest.mark.asyncio
async def test_find_type_d(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    assert await find(gdrive_accessor, spec("/"), type="d") == ["/", "/sub"]


@pytest.mark.asyncio
async def test_find_maxdepth(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    out = await find(gdrive_accessor, spec("/"), maxdepth=1)
    assert out == ["/", "/Report.gdoc.json", "/a.txt", "/sub"]


@pytest.mark.asyncio
async def test_find_size_bounds_dirs_are_zero(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    assert await find(gdrive_accessor, spec("/sub"), min_size=1024) == \
        ["/sub/big.bin"]
    assert await find(gdrive_accessor, spec("/sub"), max_size=100) == \
        ["/sub", "/sub/small.bin"]


@pytest.mark.asyncio
async def test_find_missing_root_is_empty(fake_drive, gdrive_accessor):
    assert await find(gdrive_accessor, spec("/missing")) == []
