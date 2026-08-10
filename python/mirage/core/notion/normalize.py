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

from mirage.core.notion.pathing import extract_title
from mirage.core.notion.render import blocks_to_markdown


def normalize_page(page: dict[str, Any],
                   blocks: list[dict[str, Any]]) -> dict[str, Any]:
    parent = page.get("parent", {})
    parent_type = parent.get("type", "")
    parent_id = parent.get(parent_type, "")
    if not isinstance(parent_id, str):
        parent_id = ""
    content_blocks = [
        b for b in blocks
        if b.get("type") not in ("child_page", "child_database")
    ]
    properties = page.get("properties", {})
    if not isinstance(properties, dict):
        properties = {}
    # A database row's cells are its `properties`, and they are the reason
    # the row exists, so they belong in the file rather than only in a
    # `datasources query`. Kept as Notion's own property objects for the
    # same reason `blocks` is: the schema they answer to is rendered one
    # level up, in data_source.json's `properties`.
    return {
        "page_id": page.get("id", ""),
        "title": extract_title(page),
        "url": page.get("url", ""),
        "created_time": page.get("created_time", ""),
        "last_edited_time": page.get("last_edited_time", ""),
        "parent_type": parent_type,
        "parent_id": parent_id,
        "archived": page.get("archived", False),
        "created_by": page.get("created_by", {}).get("id", ""),
        "last_edited_by": page.get("last_edited_by", {}).get("id", ""),
        "properties": properties,
        "markdown": blocks_to_markdown(content_blocks),
        "blocks": content_blocks,
    }


def normalize_database(database: dict[str, Any]) -> dict[str, Any]:
    title_items = database.get("title", [])
    title = "".join(item.get("plain_text", "") for item in title_items)
    return {
        "database_id": database.get("id", ""),
        "title": title,
        "url": database.get("url", ""),
        "created_time": database.get("created_time", ""),
        "last_edited_time": database.get("last_edited_time", ""),
        "parent": database.get("parent", {}),
        "archived": database.get("archived", database.get("in_trash", False)),
        "is_inline": database.get("is_inline", False),
        "data_sources": database.get("data_sources", []),
    }


def normalize_data_source(data_source: dict[str, Any]) -> dict[str, Any]:
    title_items = data_source.get("title", [])
    title = "".join(item.get("plain_text", "") for item in title_items)
    parent = data_source.get("parent", {})
    return {
        "data_source_id": data_source.get("id", ""),
        "database_id": parent.get("database_id", ""),
        "title": title,
        "created_time": data_source.get("created_time", ""),
        "last_edited_time": data_source.get("last_edited_time", ""),
        "database_parent": data_source.get("database_parent", {}),
        "archived": data_source.get("archived",
                                    data_source.get("in_trash", False)),
        "properties": data_source.get("properties", {}),
    }


def to_json_bytes(obj: dict[str, Any] | list[Any]) -> bytes:
    return json.dumps(obj, indent=2, ensure_ascii=False).encode("utf-8")
