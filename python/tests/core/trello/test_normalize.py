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
from pathlib import Path

import pytest

from mirage.core.render.json import jsonl_bytes_by_created_at
from mirage.core.trello.normalize import (
    normalize_board,
    normalize_card,
    normalize_comment,
    normalize_label,
    normalize_list,
    normalize_member,
    normalize_workspace,
)


def test_normalize_workspace():
    ws = {"id": "ws1", "displayName": "Engineering", "name": "eng"}
    result = normalize_workspace(ws)
    assert result["workspace_id"] == "ws1"
    assert result["workspace_name"] == "Engineering"


def test_normalize_board():
    board = {
        "id": "b1",
        "name": "Product Roadmap",
        "idOrganization": "ws1",
        "closed": False,
        "url": "https://trello.com/b/abc",
    }
    result = normalize_board(board)
    assert result["board_id"] == "b1"
    assert result["board_name"] == "Product Roadmap"
    assert result["workspace_id"] == "ws1"
    assert result["closed"] is False


def test_normalize_list():
    lst = {
        "id": "l1",
        "name": "Backlog",
        "idBoard": "b1",
        "closed": False,
        "pos": 1024,
    }
    result = normalize_list(lst)
    assert result["list_id"] == "l1"
    assert result["list_name"] == "Backlog"
    assert result["board_id"] == "b1"


def test_normalize_member():
    member = {"id": "m1", "username": "alice", "fullName": "Alice Smith"}
    result = normalize_member(member)
    assert result["member_id"] == "m1"
    assert result["username"] == "alice"
    assert result["full_name"] == "Alice Smith"


def test_normalize_label():
    label = {"id": "lb1", "name": "bug", "color": "red", "idBoard": "b1"}
    result = normalize_label(label)
    assert result["label_id"] == "lb1"
    assert result["label_name"] == "bug"
    assert result["color"] == "red"


def test_normalize_card():
    card = {
        "id": "c1",
        "name": "Fix login",
        "idBoard": "b1",
        "idList": "l1",
        "idMembers": ["m1"],
        "labels": [{"id": "lb1", "name": "bug"}],
        "due": "2026-04-10",
        "dueComplete": False,
        "closed": False,
        "desc": "Login is broken",
        "shortUrl": "https://trello.com/c/abc",
        "members": [{"id": "m1", "username": "alice"}],
    }
    result = normalize_card(card)
    assert result["card_id"] == "c1"
    assert result["card_name"] == "Fix login"
    assert result["member_ids"] == ["m1"]
    assert result["label_ids"] == ["lb1"]
    assert result["desc"] == "Login is broken"


def test_normalize_comment():
    comment = {
        "id": "act1",
        "date": "2026-04-05T10:00:00Z",
        "memberCreator": {"id": "m1", "fullName": "Alice"},
        "data": {"text": "This needs fixing"},
    }
    result = normalize_comment(comment, card_id="c1")
    assert result["comment_id"] == "act1"
    assert result["card_id"] == "c1"
    assert result["member_id"] == "m1"
    assert result["text"] == "This needs fixing"


def test_jsonl_bytes_by_created_at():
    rows = [
        {"created_at": "2026-04-05", "text": "second"},
        {"created_at": "2026-04-01", "text": "first"},
    ]
    result = jsonl_bytes_by_created_at(rows)
    lines = result.strip().split(b"\n")
    assert len(lines) == 2
    assert json.loads(lines[0])["text"] == "first"
    assert json.loads(lines[1])["text"] == "second"


def test_to_jsonl_bytes_empty():
    assert jsonl_bytes_by_created_at([]) == b""


@pytest.mark.parametrize(
    "case",
    [
        case
        for case in json.loads(
            (
                Path(__file__).resolve().parents[4]
                / "integ/fixtures/normalized_records.json"
            ).read_text()
        )["cases"]
        if case["backend"] == "trello"
    ],
    ids=lambda case: case["id"],
)
def test_shared_normalized_records(case):
    normalizers = {
        "workspace": normalize_workspace,
        "list": normalize_list,
        "card": normalize_card,
    }
    assert normalizers[case["kind"]](case["value"]) == case["expect"]
