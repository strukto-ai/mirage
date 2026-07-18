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

from mirage.utils.naming import parse_id_name
from mirage.utils.sanitize import sanitize_name

split_suffix_id = parse_id_name


def workspace_dirname(workspace: dict[str, Any]) -> str:
    label = sanitize_name(
        workspace.get("displayName") or workspace.get("name") or "workspace")
    return f"{label}__{workspace['id']}"


def board_dirname(board: dict[str, Any]) -> str:
    label = sanitize_name(board.get("name") or "board")
    return f"{label}__{board['id']}"


def list_dirname(lst: dict[str, Any]) -> str:
    label = sanitize_name(lst.get("name") or "list")
    return f"{label}__{lst['id']}"


def card_dirname(card: dict[str, Any]) -> str:
    label = sanitize_name(card.get("name") or "card")
    return f"{label}__{card['id']}"


def member_filename(member: dict[str, Any]) -> str:
    label = sanitize_name(
        member.get("fullName") or member.get("username") or "member")
    return f"{label}__{member['id']}.json"


def label_filename(label: dict[str, Any]) -> str:
    name = label.get("name") or label.get("color") or "label"
    return f"{sanitize_name(name)}__{label['id']}.json"
