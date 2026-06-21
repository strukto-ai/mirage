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

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.notion import readdir as readdir_mod
from mirage.core.notion.stat import stat
from mirage.types import PathSpec

_ACCESSOR = SimpleNamespace(config=None)

TOP_ID = "aaaa1111-2222-3333-4444-555566667777"

_TOP_PAGE = {
    "id": TOP_ID,
    "parent": {
        "type": "workspace"
    },
    "last_edited_time": "2026-01-02T00:00:00.000Z",
    "properties": {
        "title": {
            "type": "title",
            "title": [{
                "type": "text",
                "plain_text": "Top1"
            }],
        }
    },
}


async def _fake_search_pages(config):
    return [_TOP_PAGE]


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    monkeypatch.setattr(readdir_mod, "search_pages", _fake_search_pages)


def _spec(original: str, prefix: str = "") -> PathSpec:
    return PathSpec(original=original, directory=original, prefix=prefix)


@pytest.mark.asyncio
async def test_stat_page_returns_modified_from_index():
    index = RAMIndexCacheStore()
    await readdir_mod.readdir(_ACCESSOR, _spec("/notion/pages", "/notion"),
                              index)
    spec = _spec(f"/notion/pages/Top1__{TOP_ID}", "/notion")
    s = await stat(_ACCESSOR, spec, index)
    assert s.modified == "2026-01-02T00:00:00.000Z"
