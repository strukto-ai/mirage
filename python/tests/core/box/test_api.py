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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.box._client import BoxTokenManager
from mirage.core.box.api import (SEARCH_FIELDS, list_folder_items,
                                 search_content)
from mirage.core.box.config import BoxConfig


@pytest.fixture
def tm():
    return BoxTokenManager(BoxConfig(access_token="tok"))


@pytest.mark.asyncio
async def test_list_folder_items_follows_offset_pagination(tm):
    pages = [
        {
            "total_count":
            3,
            "entries": [{
                "id": "1",
                "name": "a",
                "type": "file"
            }, {
                "id": "2",
                "name": "b",
                "type": "file"
            }]
        },
        {
            "total_count": 3,
            "entries": [{
                "id": "3",
                "name": "c",
                "type": "file"
            }]
        },
    ]
    with patch(
            "mirage.core.box.api.box_get",
            new_callable=AsyncMock,
            side_effect=pages,
    ) as mock_get:
        items = await list_folder_items(tm, "0", limit=2)
    assert [it["id"] for it in items] == ["1", "2", "3"]
    assert mock_get.await_count == 2
    _, second = mock_get.await_args_list[1]
    assert second["params"]["offset"] == 2


@pytest.mark.asyncio
async def test_list_folder_items_stops_on_empty_page(tm):
    with patch(
            "mirage.core.box.api.box_get",
            new_callable=AsyncMock,
            return_value={
                "total_count": 5,
                "entries": []
            },
    ) as mock_get:
        items = await list_folder_items(tm, "0")
    assert items == []
    assert mock_get.await_count == 1


@pytest.mark.asyncio
async def test_search_content_scopes_and_matches_content(tm):
    with patch(
            "mirage.core.box.api.box_get",
            new_callable=AsyncMock,
            return_value={
                "total_count": 1,
                "entries": [{
                    "id": "9",
                    "name": "hit",
                    "type": "file"
                }]
            },
    ) as mock_get:
        items, truncated = await search_content(tm, "needle", "42")
    assert items[0]["id"] == "9"
    assert truncated is False
    _, kwargs = mock_get.await_args
    assert kwargs["params"]["ancestor_folder_ids"] == "42"
    assert kwargs["params"]["content_types"] == "name,file_content"
    assert kwargs["params"]["type"] == "file"
    assert kwargs["params"]["fields"] == SEARCH_FIELDS


@pytest.mark.asyncio
async def test_search_content_flags_truncation_at_ceiling(tm):
    page = {
        "total_count":
        20_000,
        "entries": [{
            "id": str(i),
            "name": "f",
            "type": "file"
        } for i in range(200)],
    }
    with patch(
            "mirage.core.box.api.box_get",
            new_callable=AsyncMock,
            return_value=page,
    ):
        items, truncated = await search_content(tm, "q", "0")
    assert truncated is True
    assert len(items) >= 10_000
