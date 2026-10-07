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

from mirage.commands.builtin.utils.output import format_records
from mirage.core.lancedb.tree import TREE
from mirage.core.vector.search import search_results
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


async def _search(accessor, query: str, path: str, top_k: int = 1) -> str:
    spec = PathSpec(
        vfs_path=mount_key(path, "/db"), virtual=path, directory=path
    )
    out = await search_results(
        TREE,
        accessor,
        query,
        [spec],
        top_k=top_k,
        threshold=0.0,
        mount_prefix="/db",
    )
    return format_records([text for _, text in out]).decode()


@pytest.mark.asyncio
async def test_search_emits_canonical_path_with_score(accessor):
    out = await _search(accessor, "a small white dog", "/db/animals", 2)
    assert out.splitlines()[0].startswith("/db/animals/dog/small/4.md:")


@pytest.mark.asyncio
async def test_search_body_matches_card(accessor):
    out = await _search(accessor, "a small white dog", "/db/animals")
    assert "# a small white dog" in format_records([text for _, text in out])
    assert "label: dog" in format_records([text for _, text in out])
    assert "score:" not in format_records([text for _, text in out])


@pytest.mark.asyncio
async def test_search_spells_group_values_as_the_listing_does(edged):
    # A path the listing never shows is one ``cat`` cannot open: the group
    # segment renders the way readdir renders it, escape lead and all.
    for query, head in (
        ("one", "/db/docs/a∕b/1.md:"),
        ("two", "/db/docs/⁄/2.md:"),
        ("three", "/db/docs/⁄.env/3.md:"),
    ):
        out = await _search(edged, query, "/db/docs")
        assert out.splitlines()[0].startswith(head)
