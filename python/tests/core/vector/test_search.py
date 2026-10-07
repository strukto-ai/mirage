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
from mirage.core.vector.search import make_search, search_results
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.types import SearchQuery


def _ps(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(path, "/db"), virtual=path, directory=path
    )


async def _headers(
    tree, accessor, path: str, top_k: int = 10, threshold: float = 0.0
) -> list[str]:
    out = await search_results(
        tree,
        accessor,
        "q",
        [_ps(path)],
        top_k=top_k,
        threshold=threshold,
        mount_prefix="/db",
    )
    return [
        line
        for line in format_records([text for _, text in out])
        .decode()
        .splitlines()
        if ":" in line
    ]


@pytest.mark.asyncio
async def test_a_hit_is_spelled_under_its_table_with_its_rank(tree, accessor):
    out = await search_results(
        tree,
        accessor,
        "q",
        [_ps("/db/animals")],
        top_k=1,
        threshold=0.0,
        mount_prefix="/db",
    )
    assert (
        format_records([text for _, text in out])
        == b"/db/animals/cat/1.txt:0.9000\ncat\n"
    )


@pytest.mark.asyncio
async def test_a_pinned_table_is_not_a_segment(tree, pinned):
    assert await _headers(tree, pinned, "/db", top_k=1) == [
        "/db/cat/1.txt:0.9000"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tree_name,kept",
    [
        ("tree", "/db/animals/cat/1.txt:0.9000"),
        ("distance_tree", "/db/animals/dog/2.txt:0.2000"),
    ],
)
async def test_the_threshold_drops_ranks_in_the_store_s_direction(
    request, accessor, tree_name, kept
):
    tree = request.getfixturevalue(tree_name)
    assert await _headers(tree, accessor, "/db/animals", threshold=0.5) == [
        kept
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "query,top_k,path,message",
    [
        ("", 2, "/db/animals", "search: query is required"),
        ("q", 0, "/db/animals", "search: top-k must be positive"),
        ("q", 2, "/db", "search: no table to search"),
    ],
)
async def test_a_refused_search_says_why(
    tree, accessor, query, top_k, path, message
):
    with pytest.raises(ValueError) as err:
        await search_results(
            tree,
            accessor,
            query,
            [_ps(path)],
            top_k=top_k,
            threshold=0.0,
            mount_prefix="/db",
        )
    assert str(err.value) == message
    assert not isinstance(err.value, FileNotFoundError)


@pytest.mark.asyncio
async def test_one_scope_searches_as_a_batch_of_one(tree, accessor):
    ops = make_search(tree)
    query = SearchQuery("q", options={"top_k": 1})
    results = await ops.search(accessor, _ps("/db/animals"), query)
    assert results is not None
    assert [(path.virtual, text) for path, text in results] == [
        ("/db/animals/cat/1.txt", "/db/animals/cat/1.txt:0.9000\ncat"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "options,message",
    [
        ({"top_k": 1, "rerank": True}, "search: unknown options: rerank"),
        (
            {"method": "hybrid"},
            "search: only the 'semantic' method is supported",
        ),
    ],
)
async def test_a_batch_refuses_what_the_store_cannot_rank(
    tree, accessor, options, message
):
    ops = make_search(tree)
    assert ops.search_many is not None
    with pytest.raises(ValueError, match=message):
        await ops.search_many(
            accessor, [_ps("/db/animals")], SearchQuery("q", options=options)
        )
