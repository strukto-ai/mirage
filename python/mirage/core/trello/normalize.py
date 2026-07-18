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
from typing import Any


def normalize_workspace(workspace: dict[str, Any]) -> dict[str, Any]:
    return {
        "workspace_id": workspace.get("id"),
        "workspace_name": workspace.get("displayName")
        or workspace.get("name"),
    }


def normalize_board(board: dict[str, Any]) -> dict[str, Any]:
    return {
        "board_id": board.get("id"),
        "board_name": board.get("name"),
        "workspace_id": board.get("idOrganization"),
        "closed": board.get("closed"),
        "url": board.get("url"),
    }


def normalize_list(lst: dict[str, Any]) -> dict[str, Any]:
    return {
        "list_id": lst.get("id"),
        "list_name": lst.get("name"),
        "board_id": lst.get("idBoard"),
        "closed": lst.get("closed"),
        "pos": lst.get("pos"),
    }


def normalize_member(member: dict[str, Any]) -> dict[str, Any]:
    return {
        "member_id": member.get("id"),
        "username": member.get("username"),
        "full_name": member.get("fullName"),
    }


def normalize_label(label: dict[str, Any]) -> dict[str, Any]:
    return {
        "label_id": label.get("id"),
        "label_name": label.get("name"),
        "color": label.get("color"),
        "board_id": label.get("idBoard"),
    }


def normalize_card(card: dict[str, Any]) -> dict[str, Any]:
    card.get("members") or []
    labels = card.get("labels") or []
    return {
        "card_id": card.get("id"),
        "card_name": card.get("name"),
        "board_id": card.get("idBoard"),
        "list_id": card.get("idList"),
        "member_ids": card.get("idMembers") or [],
        "label_ids": [label.get("id") for label in labels],
        "due": card.get("due"),
        "due_complete": card.get("dueComplete"),
        "closed": card.get("closed"),
        "desc": card.get("desc") or "",
        "url": card.get("shortUrl") or card.get("url"),
    }


def normalize_comment(comment: dict[str, Any], *,
                      card_id: str) -> dict[str, Any]:
    member = comment.get("memberCreator") or {}
    data = comment.get("data") or {}
    return {
        "comment_id": comment.get("id"),
        "card_id": card_id,
        "member_id": member.get("id"),
        "member_name": member.get("fullName") or member.get("username"),
        "text": data.get("text") or "",
        "created_at": comment.get("date"),
    }


def to_json_bytes(value: dict[str, Any] | list[Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode()


def to_jsonl_bytes(rows: list[dict[str, Any]]) -> bytes:
    ordered = sorted(rows, key=lambda row: row.get("created_at") or "")
    if not ordered:
        return b""
    text = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        for row in ordered)
    return text.encode() + b"\n"
