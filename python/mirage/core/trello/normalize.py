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

from mirage.utils.records import (
    as_object,
    pick_bool_or_none,
    pick_number_or_none,
    pick_string,
    pick_string_array,
    records,
    string_of,
)


def normalize_workspace(workspace: dict[str, Any]) -> dict[str, Any]:
    return {
        "workspace_id": pick_string(workspace, "id"),
        "workspace_name": pick_string(workspace, "displayName", "name"),
    }


def normalize_board(board: dict[str, Any]) -> dict[str, Any]:
    return {
        "board_id": pick_string(board, "id"),
        "board_name": pick_string(board, "name"),
        "workspace_id": pick_string(board, "idOrganization"),
        "closed": pick_bool_or_none(board, "closed"),
        "url": pick_string(board, "url"),
    }


def normalize_list(lst: dict[str, Any]) -> dict[str, Any]:
    return {
        "list_id": pick_string(lst, "id"),
        "list_name": pick_string(lst, "name"),
        "board_id": pick_string(lst, "idBoard"),
        "closed": pick_bool_or_none(lst, "closed"),
        "pos": pick_number_or_none(lst, "pos"),
    }


def normalize_member(member: dict[str, Any]) -> dict[str, Any]:
    return {
        "member_id": pick_string(member, "id"),
        "username": pick_string(member, "username"),
        "full_name": pick_string(member, "fullName"),
    }


def normalize_label(label: dict[str, Any]) -> dict[str, Any]:
    return {
        "label_id": pick_string(label, "id"),
        "label_name": pick_string(label, "name"),
        "color": pick_string(label, "color"),
        "board_id": pick_string(label, "idBoard"),
    }


def normalize_card(card: dict[str, Any]) -> dict[str, Any]:
    labels = records(card.get("labels"))
    return {
        "card_id": pick_string(card, "id"),
        "card_name": pick_string(card, "name"),
        "board_id": pick_string(card, "idBoard"),
        "list_id": pick_string(card, "idList"),
        "member_ids": pick_string_array(card, "idMembers"),
        "label_ids": [
            value
            for label in labels
            if (value := pick_string(label, "id")) is not None
        ],
        "due": pick_string(card, "due"),
        "due_complete": pick_bool_or_none(card, "dueComplete"),
        "closed": pick_bool_or_none(card, "closed"),
        "desc": string_of(card, "desc"),
        "url": pick_string(card, "shortUrl", "url"),
    }


def normalize_comment(
    comment: dict[str, Any], *, card_id: str
) -> dict[str, Any]:
    member = as_object(comment.get("memberCreator"))
    data = as_object(comment.get("data"))
    return {
        "comment_id": pick_string(comment, "id"),
        "card_id": card_id,
        "member_id": pick_string(member, "id"),
        "member_name": pick_string(member, "fullName", "username"),
        "text": string_of(data, "text"),
        "created_at": pick_string(comment, "date"),
    }


# The fields of a card's JSON Trello's search reads; every other field is
# checked against the listing instead (``unsearched_text``).
SEARCHED_FIELDS = ("card_name", "desc")
