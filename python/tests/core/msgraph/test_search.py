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

import re
from urllib.parse import unquote

import pytest
from aioresponses import aioresponses

from mirage.accessor.onedrive import OneDriveAccessor, OneDriveConfig
from mirage.core.msgraph.search import files_containing
from mirage.core.onedrive.client import drive_loc
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0/me/drive"
_SEARCH = re.compile(r".*/search\(.*")
DOCS = {"value": [{"id": "3", "name": "b.txt", "size": 7, "file": {}}]}
ACCESSOR = OneDriveAccessor(OneDriveConfig(access_token="tok"))


async def ask(text: str, vfs_path: str = "") -> list[PathSpec] | None:
    virtual = "/od/" + vfs_path if vfs_path else "/od"
    scope = PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)
    loc = drive_loc(ACCESSOR.config, vfs_path)
    return await files_containing(ACCESSOR.config, [(scope, loc)], text)


@pytest.mark.asyncio
async def test_hits_are_the_walked_files_graph_names():
    with aioresponses() as m:
        m.get(
            _BASE + "/root/children",
            payload={
                "value": [
                    {"id": "1", "name": "a.txt", "size": 7, "file": {}},
                    {"id": "2", "name": "c.txt", "size": 7, "file": {}},
                    {"id": "9", "name": "Docs", "folder": {"childCount": 1}},
                ]
            },
        )
        m.get(_BASE + "/root:/Docs:/children", payload=DOCS)
        m.get(
            _SEARCH, payload={"value": [{"id": "3"}, {"id": "1"}, {"id": "9"}]}
        )
        out = await ask("wombat")
    assert out is not None
    assert sorted(p.virtual for p in out) == ["/od/Docs/b.txt", "/od/a.txt"]


@pytest.mark.asyncio
async def test_the_text_is_quoted_and_searched_from_the_scope():
    with aioresponses() as m:
        m.get(_BASE + "/root:/Docs:/children", payload=DOCS)
        m.get(_SEARCH, payload={"value": [{"id": "3"}]})
        out = await ask("it's", "Docs")
        urls = [str(url) for _, url in m.requests]
    assert out is not None
    assert [p.vfs_path for p in out] == ["Docs/b.txt"]
    assert any(
        unquote(u).startswith(_BASE + "/root:/Docs:/search(q='it''s')")
        for u in urls
    )


@pytest.mark.asyncio
async def test_a_file_listed_without_an_id_answers_none():
    two = {"value": DOCS["value"] + [{"name": "d.txt", "file": {}}]}
    with aioresponses() as m:
        m.get(_BASE + "/root:/Docs:/children", payload=two)
        m.get(_SEARCH, payload={"value": [{"id": "3"}]})
        assert await ask("wombat", "Docs") is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "listing, search",
    [
        ({"payload": DOCS}, {"payload": {"value": []}}),
        ({"payload": DOCS}, {"status": 400}),
        ({"payload": DOCS}, {"exception": TimeoutError()}),
        ({"exception": TimeoutError()}, {"payload": {"value": [{"id": "3"}]}}),
    ],
)
async def test_a_search_that_cannot_answer_answers_none(listing, search):
    with aioresponses() as m:
        m.get(_BASE + "/root:/Docs:/children", **listing)
        m.get(_SEARCH, **search)
        assert await ask("wombat", "Docs") is None
