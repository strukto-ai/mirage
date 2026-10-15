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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.notion import NotionAccessor
from mirage.core.notion import readdir as notion_readdir
from mirage.core.notion.config import NotionConfig
from mirage.vfs.notion import NotionVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over


def _page(title: str, page_id: str) -> dict[str, object]:
    return {
        "id": page_id,
        "parent": {"type": "workspace"},
        "properties": {
            "title": {"type": "title", "title": [{"plain_text": title}]}
        },
    }


@pytest.fixture
def ws(monkeypatch) -> Workspace:
    monkeypatch.setattr(
        notion_readdir,
        "search_pages",
        AsyncMock(
            return_value=[
                _page("Demo page", "uuid1"),
                _page("Roadmap", "uuid2"),
            ]
        ),
    )
    monkeypatch.setattr(
        notion_readdir, "list_block_children", AsyncMock(return_value=[])
    )
    accessor = NotionAccessor(NotionConfig(api_key="ntn_test"))
    return Workspace({"/notion/": vfs_over(NotionVFS, accessor)})


@pytest.mark.asyncio
async def test_mid_path_glob_expands_through_the_listings(ws):
    result = await ws.shell("echo /notion/pages/Demo_page__*/page.json")
    assert await result.stdout_str() == (
        "/notion/pages/Demo_page__uuid1/page.json\n"
    )


@pytest.mark.asyncio
async def test_last_component_glob(ws):
    result = await ws.shell("echo /notion/pages/Demo*")
    assert await result.stdout_str() == "/notion/pages/Demo_page__uuid1\n"
