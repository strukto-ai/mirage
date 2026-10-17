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

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mirage.core.notion import readdir as readdir_mod
from mirage.core.notion.pathing import format_segment
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.utils.sanitize import NAME_MAX_BYTES, byte_length

_ACCESSOR = SimpleNamespace(config=None, pool=None)

TOP_ID = "aaaa1111-2222-3333-4444-555566667777"

_TOP_PAGE = {
    "id": TOP_ID,
    "parent": {"type": "workspace"},
    "last_edited_time": "2026-01-02T00:00:00.000Z",
    "properties": {
        "title": {
            "type": "title",
            "title": [{"type": "text", "plain_text": "Top1"}],
        }
    },
}


async def _fake_search_pages(accessor):
    return [_TOP_PAGE]


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    monkeypatch.setattr(readdir_mod, "search_pages", _fake_search_pages)


def _spec(original: str, prefix: str = "") -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(original, prefix),
        virtual=original,
        directory=original,
    )


@pytest.mark.asyncio
async def test_root_lists_pages_and_databases():
    out = await readdir_mod.readdir(_ACCESSOR, _spec("/notion", "/notion"))
    assert [row.name for row in out] == ["pages", "databases"]


@pytest.mark.asyncio
async def test_pages_listing_carries_each_page_id_and_time():
    (page,) = await readdir_mod.readdir(_ACCESSOR, _spec("/pages"))
    assert page.name == f"Top1__{TOP_ID}"
    assert page.modified == "2026-01-02T00:00:00.000Z"
    assert page.extra == {"page_id": TOP_ID}


@pytest.mark.asyncio
async def test_a_long_child_page_title_fits_name_max(monkeypatch):
    """The child rows composed the pair inline, skipping the budget."""
    title = "会議" * 100
    child_id = "bbbb2222-3333-4444-5555-666677778888"
    monkeypatch.setattr(
        readdir_mod,
        "list_block_children",
        AsyncMock(
            return_value=[
                {
                    "type": "child_page",
                    "id": child_id,
                    "child_page": {"title": title},
                }
            ]
        ),
    )

    out = await readdir_mod.readdir(
        _ACCESSOR,
        _spec(f"/pages/Top1__{TOP_ID}"),
        FileStat(name=f"Top1__{TOP_ID}", type=FileType.DIRECTORY),
    )
    names = [row.name for row in out if row.name != "page.json"]

    assert names == [format_segment(title, child_id)]
    assert byte_length(names[0]) <= NAME_MAX_BYTES
