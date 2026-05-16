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

from mirage.core.discord.paginate import after_id_pages, offset_pages
from mirage.resource.discord.config import DiscordConfig


@pytest.fixture
def config():
    return DiscordConfig(token="t")


@pytest.mark.asyncio
async def test_after_id_pages_walks_until_partial(config):
    page1 = [{"id": "1"}, {"id": "2"}]
    page2 = [{"id": "3"}]
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               side_effect=[page1, page2]) as mock:
        collected = []
        async for page in after_id_pages(
                config,
                "/x",
                base_params={},
                last_id_fn=lambda m: m["id"],
                page_size=2,
        ):
            collected.append(page)
    assert collected == [page1, page2]
    assert mock.call_count == 2
    second_params = mock.call_args_list[1].kwargs["params"]
    assert second_params["after"] == "2"


@pytest.mark.asyncio
async def test_after_id_pages_stops_on_empty(config):
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               return_value=[]):
        pages = [
            p async for p in after_id_pages(
                config,
                "/x",
                base_params={},
                last_id_fn=lambda m: m["id"],
            )
        ]
    assert pages == []


@pytest.mark.asyncio
async def test_offset_pages_walks_and_terminates_on_total(config):
    p1 = {"messages": [["m1"], ["m2"]], "total_results": 3}
    p2 = {"messages": [["m3"]], "total_results": 3}
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               side_effect=[p1, p2]) as mock:
        collected = []
        async for items in offset_pages(
                config,
                "/y",
                base_params={"q": "x"},
                items_path=("messages", ),
                page_size=2,
        ):
            collected.append(items)
    assert collected == [[["m1"], ["m2"]], [["m3"]]]
    assert mock.call_count == 2
    assert mock.call_args_list[0].kwargs["params"]["offset"] == 0
    assert mock.call_args_list[1].kwargs["params"]["offset"] == 2


@pytest.mark.asyncio
async def test_offset_pages_respects_max_pages(config):
    p = {"messages": [["m"]], "total_results": 999}
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               return_value=p) as mock:
        collected = []
        async for items in offset_pages(
                config,
                "/y",
                base_params={},
                items_path=("messages", ),
                page_size=1,
                max_pages=2,
        ):
            collected.append(items)
    assert len(collected) == 2
    assert mock.call_count == 2
