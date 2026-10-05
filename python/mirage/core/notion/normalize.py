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

from mirage.core.notion.pathing import format_segment
from mirage.core.notion.render import blocks_to_markdown
from mirage.core.render.json import json_bytes


def _page_fields(page: dict[str, Any]) -> dict[str, Any]:
    parent = page.get("parent", {})
    parent_type = parent.get("type", "")
    parent_id = parent.get(parent_type, "")
    if not isinstance(parent_id, str):
        parent_id = ""
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
    }


def normalize_page(
    page: dict[str, Any], blocks: list[dict[str, Any]]
) -> dict[str, Any]:
    content_blocks = [
        b
        for b in blocks
        if b.get("type") not in ("child_page", "child_database")
    ]
    return {
        **_page_fields(page),
        "markdown": blocks_to_markdown(content_blocks),
        "blocks": content_blocks,
    }


def normalize_row(page: dict[str, Any]) -> dict[str, Any]:
    """One line of a data source's ``rows.jsonl``.

    The row's ``page.json`` without the body, which a query does not
    carry, and with the path of that ``page.json`` below the data source:
    the rows are not listed as directories, so the line is where a row's
    directory name is found.

    Args:
        page (dict[str, Any]): the row as a data source query returns it.
    """
    fields = _page_fields(page)
    return {
        "page_id": fields.pop("page_id"),
        "title": fields.pop("title"),
        "path": f"{page_segment_name(page)}/page.json",
        **fields,
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
        "archived": data_source.get(
            "archived", data_source.get("in_trash", False)
        ),
        "properties": data_source.get("properties", {}),
    }


def to_json_bytes(obj: dict[str, Any] | list[Any]) -> bytes:
    return json_bytes(obj)


def page_segment_name(page: dict[str, Any]) -> str:
    return format_segment(extract_title(page), page["id"])


def database_segment_name(database: dict[str, Any]) -> str:
    return format_segment(extract_database_title(database), database["id"])


def data_source_segment_name(data_source: dict[str, Any]) -> str:
    return format_segment(
        extract_data_source_title(data_source), data_source["id"]
    )


def extract_data_source_title(data_source: dict[str, Any]) -> str:
    """Read a data source's label from either shape it arrives in.

    The data source object carries rich-text ``title``; the stubs listed
    under a database's ``data_sources`` carry a plain ``name``. Both name
    the same thing, so both must render the same directory.

    Args:
        data_source (dict[str, Any]): a data source object or stub.

    Returns:
        str: the plain-text label, empty when neither field is present.
    """
    name = data_source.get("name")
    if isinstance(name, str):
        return name
    return extract_database_title(data_source)


def extract_title(page: dict[str, Any]) -> str:
    props = page.get("properties", {})
    if not isinstance(props, dict):
        return ""
    for prop in props.values():
        if not isinstance(prop, dict):
            continue
        if prop.get("type") == "title":
            title_items = prop.get("title", [])
            return "".join(item.get("plain_text", "") for item in title_items)
    return ""


def extract_database_title(database: dict[str, Any]) -> str:
    title_items = database.get("title", [])
    return "".join(item.get("plain_text", "") for item in title_items)
