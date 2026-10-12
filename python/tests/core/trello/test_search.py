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
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.trello import TrelloAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.trello.normalize import unsearched_text
from mirage.core.trello.search import SEARCH_LIMIT, files_containing
from mirage.types import JsonValue, PathSpec
from mirage.vfs.trello.config import TrelloConfig

CARDS = [
    {
        "id": "c1",
        "name": "Fix login",
        "desc": "broken",
        "idBoard": "b1",
        "idList": "l1",
        "shortUrl": "https://trello.test/c1",
    },
    {
        "id": "c2",
        "name": "Write notes",
        "desc": "",
        "idBoard": "b1",
        "idList": "l1",
        "url": "https://trello.test/c/c2/2-ship-it",
    },
    {
        "id": "c3",
        "name": "Docs",
        "desc": "Visit wombat.example.com first",
        "idBoard": "b1",
        "idList": "l1",
    },
]

LIST = "workspaces/Engineering__ws1/boards/Roadmap__b1/lists/Doing__l1"


def _scope(vfs_path: str = "") -> PathSpec:
    virtual = "/trello/" + vfs_path if vfs_path else "/trello"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


async def _ask(
    text: str,
    named: list[str] | dict[str, list[str]],
    under: list[PathSpec] | None = None,
    reply: "JsonValue | Exception" = None,
    index: RAMIndexCacheStore | None = None,
    listed: list[dict] = CARDS,
):
    accessor = TrelloAccessor(
        TrelloConfig(api_key="k", api_token="t", content_search=True)
    )

    def cards(*args, params, **kwargs):
        ids = (
            named.get(params["query"], [])
            if isinstance(named, dict)
            else named
        )
        return {"cards": [{"id": i} for i in ids]}

    found = (
        AsyncMock(side_effect=cards)
        if reply is None
        else AsyncMock(side_effect=[reply])
    )
    readdir = "mirage.core.trello.readdir"
    with (
        patch(
            f"{readdir}.list_workspaces",
            AsyncMock(
                return_value=[{"id": "ws1", "displayName": "Engineering"}]
            ),
        ),
        patch(
            f"{readdir}.list_workspace_boards",
            AsyncMock(return_value=[{"id": "b1", "name": "Roadmap"}]),
        ),
        patch(
            f"{readdir}.get_board",
            AsyncMock(return_value={"id": "b1", "name": "Roadmap"}),
        ),
        patch(
            f"{readdir}.list_board_lists",
            AsyncMock(return_value=[{"id": "l1", "name": "Doing"}]),
        ),
        patch(f"{readdir}.list_list_cards", AsyncMock(return_value=listed)),
        patch("mirage.core.trello.client._get", found),
    ):
        out = await files_containing(
            accessor, text, under or [_scope()], index or RAMIndexCacheStore()
        )
    return out, [
        call.kwargs["params"]["query"] for call in found.await_args_list
    ]


def test_unsearched_text_leaves_out_name_and_description():
    kept = unsearched_text(CARDS[1])
    assert "ship" in kept and "c2" in kept
    assert "notes" not in kept and "write" not in kept


# Trello names the card whose name holds the word; the other is named by
# its link, which Trello's search does not read.
@pytest.mark.asyncio
async def test_hits_are_what_trello_names_and_what_the_listing_kept():
    out, asked = await _ask("ship", ["c1"])
    assert out is not None
    assert [p.vfs_path for p in out] == [
        f"{LIST}/cards/Fix_login__c1/card.json",
        f"{LIST}/cards/Write_notes__c2/card.json",
    ]
    assert asked == ["ship"]


# Trello's search may miss a word inside a link, so the listing keeps it, and
# each word of a phrase is found in either place.
@pytest.mark.asyncio
async def test_a_word_in_a_link_is_kept_by_the_listing():
    out, asked = await _ask("visit wombat", {"visit": ["c3"]})
    assert out is not None
    assert [p.vfs_path for p in out] == [f"{LIST}/cards/Docs__c3/card.json"]
    assert asked == ["visit", "wombat"]


@pytest.mark.asyncio
async def test_a_card_scope_names_its_own_card_json():
    out, _ = await _ask(
        "login", ["c1"], [_scope(f"{LIST}/cards/Fix_login__c1")]
    )
    assert out is not None
    assert [p.vfs_path for p in out] == [
        f"{LIST}/cards/Fix_login__c1/card.json"
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text, named",
    [
        ("desc", ["c1"]),
        ("true", ["c1"]),
        ("q4", ["c1"]),
        ("login", []),
        ("login", [f"x{i}" for i in range(SEARCH_LIMIT)]),
    ],
)
async def test_an_unsure_answer_reads_every_file(text, named):
    out, _ = await _ask(text, named)
    assert out is None


# A reply that is not a list of cards, or not JSON, is a failed search:
# c2's link holds "ship", but Trello may have named c1 too.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply",
    [
        {"cards": {}},
        {},
        {"cards": [{"name": "Fix login"}]},
        json.JSONDecodeError("Expecting value", "<html>", 0),
    ],
)
async def test_a_garbled_reply_reads_every_file(reply):
    out, _ = await _ask("ship", [], reply=reply)
    assert out is None


# A read fetches the card as it is now, so the kept text is checked against
# listings made for the search, not the ones the walk cached; a card gone
# since is read.
@pytest.mark.asyncio
async def test_a_text_changed_since_the_listing_is_found():
    index = RAMIndexCacheStore()
    await _ask("numbat", {"numbat": ["c1"]}, index=index)
    changed = [CARDS[0], {**CARDS[1], "desc": "See numbat.io"}, CARDS[2]]
    out, _ = await _ask(
        "numbat", {"numbat": ["c1"]}, index=index, listed=changed
    )
    assert out is not None
    assert [p.vfs_path for p in out] == [
        f"{LIST}/cards/Fix_login__c1/card.json",
        f"{LIST}/cards/Write_notes__c2/card.json",
    ]
    out, _ = await _ask(
        "numbat", {"numbat": ["c1"]}, index=index, listed=CARDS[:1]
    )
    assert out is not None
    assert len(out) == len(CARDS)
