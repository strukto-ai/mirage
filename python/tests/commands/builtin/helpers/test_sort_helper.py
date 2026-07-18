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

from mirage.commands.builtin.generic.sort import sort


async def _rb(_path):
    raise AssertionError("stdin-driven tests never read paths")


async def sort_lines(data: bytes, **kwargs) -> list[str]:
    output, _ = await sort([], read_bytes=_rb, stdin=data, **kwargs)
    return output.decode().splitlines()


class TestSortDefault:

    @pytest.mark.asyncio
    async def test_alphabetical(self):
        result = await sort_lines(b"banana\napple\ncherry")
        assert result == ["apple", "banana", "cherry"]

    @pytest.mark.asyncio
    async def test_already_sorted(self):
        result = await sort_lines(b"a\nb\nc")
        assert result == ["a", "b", "c"]


class TestSortReverse:

    @pytest.mark.asyncio
    async def test_reverse(self):
        result = await sort_lines(b"banana\napple\ncherry", reverse=True)
        assert result == ["cherry", "banana", "apple"]


class TestSortNumeric:

    @pytest.mark.asyncio
    async def test_numeric(self):
        result = await sort_lines(b"10\n2\n30\n1", numeric=True)
        assert result == ["1", "2", "10", "30"]

    @pytest.mark.asyncio
    async def test_non_numeric_lines(self):
        result = await sort_lines(b"10\nabc\n2\nxyz", numeric=True)
        assert result[0] in ("abc", "xyz")
        assert "10" in result


class TestSortUnique:

    @pytest.mark.asyncio
    async def test_unique(self):
        result = await sort_lines(b"banana\napple\nbanana\napple\ncherry",
                                  unique=True)
        assert result == ["apple", "banana", "cherry"]


class TestSortIgnoreCase:

    @pytest.mark.asyncio
    async def test_ignore_case(self):
        result = await sort_lines(b"Banana\napple\nCherry", fold_case=True)
        assert result == ["apple", "Banana", "Cherry"]


class TestSortKeyField:

    @pytest.mark.asyncio
    async def test_key_field_numeric(self):
        result = await sort_lines(b"a 10\nb 2\nc 30",
                                  key_field=2,
                                  numeric=True)
        assert result == ["b 2", "a 10", "c 30"]


class TestSortFieldSep:

    @pytest.mark.asyncio
    async def test_field_sep_with_key(self):
        result = await sort_lines(b"a:10\nb:2\nc:30",
                                  field_separator=":",
                                  key_field=2,
                                  numeric=True)
        assert result == ["b:2", "a:10", "c:30"]


class TestSortMixed:

    @pytest.mark.asyncio
    async def test_numeric_reverse(self):
        result = await sort_lines(b"10\n2\n30\n1", numeric=True, reverse=True)
        assert result == ["30", "10", "2", "1"]

    @pytest.mark.asyncio
    async def test_unique_ignore_case(self):
        result = await sort_lines(b"Apple\napple\nBanana\nbanana",
                                  unique=True,
                                  fold_case=True)
        assert len(result) == 2
        assert result[0].lower() == "apple"
        assert result[1].lower() == "banana"
