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

import json
import os

import pytest

from mirage.resource.notion.config import NotionConfig
from mirage.resource.notion.notion import NotionResource
from mirage.types import PathSpec

pytestmark = pytest.mark.skipif(
    not os.environ.get("NOTION_API_KEY"),
    reason="NOTION_API_KEY not set",
)


@pytest.fixture
def config():
    return NotionConfig(api_key=os.environ["NOTION_API_KEY"])


@pytest.fixture
def resource(config):
    return NotionResource(config)


@pytest.mark.asyncio
async def test_readdir_root(resource):
    from mirage.core.notion.readdir import readdir
    entries = await readdir(resource.accessor, PathSpec.from_str_path("/"),
                            resource.index)
    assert any("pages" in e for e in entries)


@pytest.mark.asyncio
async def test_readdir_pages(resource):
    from mirage.core.notion.readdir import readdir
    entries = await readdir(resource.accessor,
                            PathSpec.from_str_path("/pages"), resource.index)
    assert len(entries) > 0


@pytest.mark.asyncio
async def test_read_page_json(resource):
    from mirage.core.notion.read import read
    from mirage.core.notion.readdir import readdir
    pages = await readdir(resource.accessor, PathSpec.from_str_path("/pages"),
                          resource.index)
    if not pages:
        pytest.skip("No pages found")
    first_page = pages[0]
    data = await read(resource.accessor,
                      PathSpec.from_str_path(f"{first_page}/page.json"),
                      resource.index)
    page = json.loads(data)
    assert "page_id" in page
    assert "title" in page
    assert "url" in page
    assert "markdown" in page
    assert "blocks" in page
    assert isinstance(page["blocks"], list)


@pytest.mark.asyncio
async def test_search(resource):
    from mirage.core.notion.pages import search_pages
    results = await search_pages(resource.config, query="", page_size=5)
    assert isinstance(results, list)
