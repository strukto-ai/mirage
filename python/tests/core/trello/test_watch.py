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

import asyncio

from mirage.accessor.trello import TrelloAccessor
from mirage.core.trello.watch import TrelloEventHook
from mirage.types import FileChangeKind, PathSpec
from mirage.vfs.trello.config import TrelloConfig

C, U, D, M, X = (
    FileChangeKind.CREATE,
    FileChangeKind.UPDATE,
    FileChangeKind.DELETE,
    FileChangeKind.MOVE,
    FileChangeKind.UNKNOWN,
)
BOARD = {"id": "b1", "name": "Roadmap"}
TODO = {"id": "l1", "name": "To Do"}
DONE = {"id": "l2", "name": "Done"}
CARD = {"id": "c1", "name": "Ship it"}
BOARD_DIR = "/t/workspaces/Acme__w1/boards/Roadmap__b1"
TODO_CARD = f"{BOARD_DIR}/lists/To_Do__l1/cards/Ship_it__c1"
DONE_CARD = f"{BOARD_DIR}/lists/Done__l2/cards/Ship_it__c1"


def _root() -> PathSpec:
    return PathSpec(virtual="/t", directory="/t", vfs_path="")


def _hook(monkeypatch, **config) -> tuple[TrelloEventHook, list[str]]:
    calls: list[str] = []

    async def fake_workspaces(config, session=None):
        calls.append("workspaces")
        return [{"id": "w1", "displayName": "Acme"}]

    async def fake_board(config, board_id, session=None):
        calls.append(f"board {board_id}")
        return {"id": board_id, "idOrganization": "w1"}

    monkeypatch.setattr(
        "mirage.core.trello.watch.list_workspaces", fake_workspaces
    )
    monkeypatch.setattr("mirage.core.trello.watch.get_board", fake_board)
    accessor = TrelloAccessor(
        TrelloConfig(api_key="k", api_token="t", **config)
    )
    return TrelloEventHook(accessor), calls


def _body(kind: str, model: dict | None = None, **data) -> dict:
    return {
        "action": {"type": kind, "data": {"board": BOARD, **data}},
        "model": model
        or {"id": "b1", "name": "Roadmap", "idOrganization": "w1"},
    }


def _map(hook, body) -> list[tuple[FileChangeKind, str]]:
    kind = body["action"]["type"]
    events = asyncio.run(hook.to_events(_root(), kind, body))
    return [(e.kind, e.path.virtual) for e in events]


def _moves(hook, body) -> list[tuple[str, str]]:
    kind = body["action"]["type"]
    events = asyncio.run(hook.to_events(_root(), kind, body))
    assert all(e.kind is M for e in events)
    return [(e.previous_path.virtual, e.path.virtual) for e in events]


def test_a_card_made_creates_both_files_from_the_board_model(monkeypatch):
    hook, calls = _hook(monkeypatch)
    found = _map(hook, _body("createCard", card=CARD, list=TODO))
    assert found == [
        (C, f"{TODO_CARD}/card.json"),
        (C, f"{TODO_CARD}/comments.jsonl"),
    ]
    assert calls == ["workspaces"]


def test_a_card_moved_between_lists_moves_both_files(monkeypatch):
    hook, _ = _hook(monkeypatch)
    body = _body(
        "updateCard",
        card={**CARD, "idList": "l2"},
        old={"idList": "l1"},
        listBefore=TODO,
        listAfter=DONE,
    )
    assert _moves(hook, body) == [
        (f"{TODO_CARD}/card.json", f"{DONE_CARD}/card.json"),
        (f"{TODO_CARD}/comments.jsonl", f"{DONE_CARD}/comments.jsonl"),
    ]


def test_a_card_renamed_moves_and_an_edit_updates(monkeypatch):
    hook, _ = _hook(monkeypatch)
    renamed = _body("updateCard", card=CARD, old={"name": "Draft"}, list=TODO)
    draft = f"{BOARD_DIR}/lists/To_Do__l1/cards/Draft__c1"
    assert _moves(hook, renamed)[0] == (
        f"{draft}/card.json",
        f"{TODO_CARD}/card.json",
    )
    edited = _body("updateCard", card=CARD, old={"desc": ""}, list=TODO)
    assert _map(hook, edited) == [(U, f"{TODO_CARD}/card.json")]
    labelled = _body("addLabelToCard", card=CARD, list=TODO)
    assert _map(hook, labelled) == [(U, f"{TODO_CARD}/card.json")]


def test_a_card_archived_leaves_and_a_comment_updates_its_thread(
    monkeypatch,
):
    hook, _ = _hook(monkeypatch)
    archived = _body(
        "updateCard",
        card={**CARD, "closed": True},
        old={"closed": False},
        list=TODO,
    )
    assert _map(hook, archived) == [(D, TODO_CARD)]
    restored = _body(
        "updateCard",
        card={**CARD, "closed": False},
        old={"closed": True},
        list=TODO,
    )
    assert [kind for kind, _ in _map(hook, restored)] == [C, C]
    comment = _body("commentCard", card=CARD, list=TODO, text="hi")
    assert _map(hook, comment) == [(U, f"{TODO_CARD}/comments.jsonl")]


def test_a_deleted_card_is_found_where_it_was_seen(monkeypatch):
    hook, _ = _hook(monkeypatch)
    _map(hook, _body("createCard", card=CARD, list=TODO))
    gone = _body("deleteCard", card={"id": "c1", "idShort": 4}, list=TODO)
    assert _map(hook, gone) == [(D, TODO_CARD)]
    unseen = _body("deleteCard", card={"id": "c9"}, list=TODO)
    assert _map(hook, unseen) == [(X, f"{BOARD_DIR}/lists/To_Do__l1/cards")]


def test_a_list_or_board_renamed_is_unknown_on_both_places(monkeypatch):
    hook, _ = _hook(monkeypatch)
    lst = _body("updateList", list=DONE, old={"name": "Doing"})
    assert _map(hook, lst) == [
        (X, f"{BOARD_DIR}/lists/Doing__l2"),
        (X, f"{BOARD_DIR}/lists/Done__l2"),
    ]
    moved = _body("updateList", list=DONE, old={"pos": 1})
    assert _map(hook, moved) == [(U, f"{BOARD_DIR}/lists/Done__l2/list.json")]
    board = _body("updateBoard", old={"name": "Plans"})
    assert _map(hook, board) == [
        (X, "/t/workspaces/Acme__w1/boards/Plans__b1"),
        (X, BOARD_DIR),
    ]
    closed = _body("updateBoard", old={"closed": False})
    closed["action"]["data"]["board"] = {**BOARD, "closed": True}
    assert _map(hook, closed) == [(D, BOARD_DIR)]


def test_labels_and_members_are_unknown_on_their_listing(monkeypatch):
    hook, _ = _hook(monkeypatch)
    assert _map(hook, _body("createLabel", label={"id": "x"})) == [
        (X, f"{BOARD_DIR}/labels")
    ]
    assert _map(hook, _body("addMemberToBoard")) == [
        (X, f"{BOARD_DIR}/members")
    ]


def test_a_board_outside_the_mount_maps_to_nothing(monkeypatch):
    hook, calls = _hook(monkeypatch, board_ids=["b9"])
    assert _map(hook, _body("createCard", card=CARD, list=TODO)) == []
    hook, calls = _hook(monkeypatch, workspace_id="w2")
    card_model = {"id": "c1", "name": "Ship it"}
    body = _body("createCard", model=card_model, card=CARD, list=TODO)
    assert _map(hook, body) == []
    assert calls == ["board b1"]
