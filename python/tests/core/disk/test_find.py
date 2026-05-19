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

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.find import find
from mirage.types import PathSpec


@pytest.mark.asyncio
async def test_find_all_files(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.txt").write_text("b")
    accessor = DiskAccessor(tmp_path)
    result = await find(accessor, PathSpec(original="/", directory="/"))
    assert "/a.txt" in result
    assert "/sub/b.txt" in result
    assert "/sub" in result


@pytest.mark.asyncio
async def test_find_with_name_pattern(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "b.py").write_text("b")
    accessor = DiskAccessor(tmp_path)
    result = await find(accessor,
                        PathSpec(original="/", directory="/"),
                        name="*.txt")
    assert result == ["/a.txt"]


@pytest.mark.asyncio
async def test_find_with_type_filter_file(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "sub").mkdir()
    accessor = DiskAccessor(tmp_path)
    result = await find(accessor,
                        PathSpec(original="/", directory="/"),
                        type="f")
    assert "/a.txt" in result
    assert "/sub" not in result


@pytest.mark.asyncio
async def test_find_with_type_filter_directory(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "sub").mkdir()
    accessor = DiskAccessor(tmp_path)
    result = await find(accessor,
                        PathSpec(original="/", directory="/"),
                        type="d")
    assert "/sub" in result
    assert "/a.txt" not in result


@pytest.mark.asyncio
async def test_find_with_maxdepth(tmp_path):
    (tmp_path / "a.txt").write_text("a")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "b.txt").write_text("b")
    (tmp_path / "sub" / "deep").mkdir()
    (tmp_path / "sub" / "deep" / "c.txt").write_text("c")
    accessor = DiskAccessor(tmp_path)
    result = await find(accessor,
                        PathSpec(original="/", directory="/"),
                        maxdepth=1)
    assert "/a.txt" in result
    assert "/sub" in result
    assert "/sub/b.txt" not in result
    assert "/sub/deep/c.txt" not in result
