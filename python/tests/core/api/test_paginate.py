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

from typing import Any

import pytest

from mirage.core.api.errors import PaginationStalledError
from mirage.core.api.paginate import (
    HAS_MORE_PAGES,
    PageShape,
    cursor_items,
    has_more_cursor,
    offset_cursor,
)


class _Pager:
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self.pages = list(pages)
        self.cursors: list[str | None] = []

    async def fetch(self, cursor: str | None) -> dict[str, Any]:
        self.cursors.append(cursor)
        return self.pages.pop(0)


@pytest.mark.asyncio
async def test_collects_across_pages_and_threads_the_cursor():
    pager = _Pager(
        [
            {
                "results": [{"n": 1}, {"n": 2}],
                "has_more": True,
                "next_cursor": "c1",
            },
            {
                "results": [{"n": 3}],
                "has_more": False,
            },
        ]
    )
    items = await cursor_items(pager.fetch)
    assert [item["n"] for item in items] == [1, 2, 3]
    assert pager.cursors == [None, "c1"]


@pytest.mark.asyncio
async def test_max_results_slices_the_last_page():
    pager = _Pager(
        [
            {
                "results": [{"n": 1}, {"n": 2}],
                "has_more": True,
                "next_cursor": "c1",
            },
            {
                "results": [{"n": 3}, {"n": 4}],
                "has_more": True,
                "next_cursor": "c2",
            },
        ]
    )
    items = await cursor_items(pager.fetch, max_results=3)
    assert [item["n"] for item in items] == [1, 2, 3]
    assert len(pager.cursors) == 2


@pytest.mark.asyncio
async def test_has_more_without_a_usable_cursor_stops():
    pager = _Pager([{"results": [{"n": 1}], "has_more": True}])
    assert await cursor_items(pager.fetch) == [{"n": 1}]

    pager = _Pager(
        [
            {
                "results": [{"n": 1}],
                "has_more": True,
                "next_cursor": "",
            }
        ]
    )
    assert await cursor_items(pager.fetch) == [{"n": 1}]


@pytest.mark.asyncio
async def test_a_non_list_results_field_contributes_nothing():
    pager = _Pager([{"results": {"weird": 1}, "has_more": False}])
    assert await cursor_items(pager.fetch) == []


@pytest.mark.asyncio
async def test_an_offset_shape_reads_its_own_items_and_cursor():
    shape = PageShape(items_key="records", next_cursor=offset_cursor)
    pager = _Pager(
        [
            {"records": [{"n": 1}], "offset": "itr1/rec1"},
            {"records": [{"n": 2}]},
        ]
    )
    items = await cursor_items(pager.fetch, shape=shape)
    assert [item["n"] for item in items] == [1, 2]
    assert pager.cursors == [None, "itr1/rec1"]


@pytest.mark.asyncio
async def test_a_null_offset_ends_the_walk():
    # Airtable's comment listing sends "offset": null on its last page.
    shape = PageShape(items_key="comments", next_cursor=offset_cursor)
    pager = _Pager([{"comments": [{"n": 1}], "offset": None}])
    assert await cursor_items(pager.fetch, shape=shape) == [{"n": 1}]


@pytest.mark.asyncio
async def test_a_repeated_cursor_fails_instead_of_looping():
    pager = _Pager(
        [
            {"results": [{"n": 1}], "has_more": True, "next_cursor": "c1"},
            {"results": [{"n": 2}], "has_more": True, "next_cursor": "c1"},
        ]
    )
    with pytest.raises(PaginationStalledError) as exc:
        await cursor_items(pager.fetch)
    assert exc.value.cursor == "c1"


def test_the_default_shape_is_notions():
    assert HAS_MORE_PAGES.items_key == "results"
    assert has_more_cursor({"has_more": True, "next_cursor": "c"}) == "c"
    assert has_more_cursor({"has_more": False, "next_cursor": "c"}) is None
    assert offset_cursor({"offset": ""}) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, -1])
async def test_empty_limit_avoids_the_request(limit):
    pager = _Pager([])
    assert await cursor_items(pager.fetch, max_results=limit) == []
    assert pager.cursors == []
