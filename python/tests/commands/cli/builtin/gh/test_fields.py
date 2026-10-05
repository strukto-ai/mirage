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

from mirage.commands.cli.builtin.gh.fields import (
    SHARED_FIELDS,
    exported_node,
    read_rest,
    selection,
)

TABLE = dict(SHARED_FIELDS)


def _comments(bodies, following):
    return {
        "comments": {
            "nodes": [{"body": body} for body in bodies],
            "pageInfo": {
                "hasNextPage": following is not None,
                "endCursor": following,
            },
        }
    }


def test_each_field_is_asked_for_once_in_the_order_named():
    assert (
        selection(TABLE, ["title", "number", "title"], False) == "title,number"
    )


def test_a_view_leaves_out_what_it_reads_apart():
    assert selection(TABLE, ["title", "projectItems"], True) == "title"
    assert selection(TABLE, ["title", "projectItems"], False).startswith(
        "title,projectItems(first:100)"
    )


@pytest.mark.asyncio
async def test_a_paged_connection_is_read_to_its_end():
    node = _comments(["a"], "c1")
    asked = []

    async def fetch(select, cursor):
        asked.append((select, cursor))
        return _comments(["b"], None)

    await read_rest(TABLE, node, ["comments"], fetch)

    out = exported_node(TABLE, node, ["comments"])["comments"]
    assert [comment["body"] for comment in out] == ["a", "b"]
    assert len(asked) == 1
    assert "comments(first: 100, after: $endCursor)" in asked[0][0]
    assert asked[0][1] == "c1"


@pytest.mark.asyncio
async def test_a_cursor_that_does_not_advance_is_refused():
    async def fetch(select, cursor):
        return _comments(["b"], "c1")

    with pytest.raises(ValueError, match="non-advancing cursor"):
        await read_rest(TABLE, _comments(["a"], "c1"), ["comments"], fetch)


@pytest.mark.asyncio
async def test_project_items_are_read_apart_and_none_without_the_scope():
    async def items(select, cursor):
        assert select.startswith("projectItems(first: 100)")
        return {
            "projectItems": {
                "nodes": [
                    {
                        "project": {"title": "Roadmap"},
                        "status": {"optionId": "o1", "name": "Todo"},
                    }
                ],
                "pageInfo": {"hasNextPage": False, "endCursor": None},
            }
        }

    node = await read_rest(TABLE, {}, ["projectItems"], items)
    assert exported_node(TABLE, node, ["projectItems"]) == {
        "projectItems": [
            {"status": {"optionId": "o1", "name": "Todo"}, "title": "Roadmap"}
        ]
    }

    async def unscoped(select, cursor):
        raise ValueError(
            "GraphQL: The 'id' field requires one of the "
            "following scopes: ['read:project'], but"
        )

    none = await read_rest(TABLE, {}, ["projectItems"], unscoped)
    assert exported_node(TABLE, none, ["projectItems"]) == {"projectItems": []}
