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

from mirage.core.api.client import SessionArg, SessionPool
from mirage.core.notion import pages as pages_mod

ROOT_ID = "aaaa1111-2222-3333-4444-555566667777"
NESTED_ID = "bbbb1111-2222-3333-4444-555566667777"

_TREE: dict[str, list[dict[str, Any]]] = {
    f"/blocks/{ROOT_ID}/children": [{
        "id": NESTED_ID,
        "type": "toggle",
        "has_children": True,
    }],
    f"/blocks/{NESTED_ID}/children": [{
        "id": "cccc1111-2222-3333-4444-555566667777",
        "type": "paragraph",
        "has_children": False,
    }],
}


@pytest.mark.asyncio
async def test_block_tree_threads_one_session_through_every_level(monkeypatch):
    """The recursion dropped the session, so nested pages churned one
    ClientSession per block request while the top level rode the pool."""
    pool = SessionPool()
    seen: list[SessionArg] = []

    async def fake_paginate_list(config, path, page_size=100, session=None):
        seen.append(session)
        return _TREE[path]

    monkeypatch.setattr(pages_mod, "paginate_list", fake_paginate_list)
    blocks = await pages_mod.list_block_tree(None, ROOT_ID, session=pool)

    assert [b["id"] for b in blocks] == [NESTED_ID]
    assert len(seen) == 2
    assert all(s is pool for s in seen)
