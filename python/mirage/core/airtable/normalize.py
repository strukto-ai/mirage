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

from mirage.core.render.json import jsonl_bytes


def as_row(value: Any) -> dict[str, Any]:
    """A decoded JSON object, or an empty one for anything else.

    Args:
        value (Any): a decoded JSON value.
    """
    return value if isinstance(value, dict) else {}


def as_rows(value: Any) -> list[dict[str, Any]]:
    """The objects of a decoded JSON array; anything else holds none.

    Args:
        value (Any): a decoded JSON value.
    """
    if not isinstance(value, list):
        return []
    return [row for row in value if isinstance(row, dict)]


def normalize_base_summary(base: dict[str, Any]) -> dict[str, Any]:
    """One base as the listing names it: id, name and permission level.

    Args:
        base (dict[str, Any]): the base-listing row.
    """
    return {
        "base_id": base.get("id"),
        "base_name": base.get("name"),
        "permission_level": base.get("permissionLevel"),
    }


def normalize_base(
    base: dict[str, Any], tables: list[dict[str, Any]]
) -> dict[str, Any]:
    """base.json: the base and the tables it holds.

    Args:
        base (dict[str, Any]): the base-listing row.
        tables (list[dict[str, Any]]): the base's schema tables.
    """
    return {
        **normalize_base_summary(base),
        "tables": [
            {
                "table_id": table.get("id"),
                "table_name": table.get("name"),
                "primary_field_id": table.get("primaryFieldId"),
            }
            for table in tables
        ],
    }


def normalize_field(field: dict[str, Any]) -> dict[str, Any]:
    """One column: its id, name, type and the type's options.

    Args:
        field (dict[str, Any]): a schema field.
    """
    return {
        "field_id": field.get("id"),
        "field_name": field.get("name"),
        "type": field.get("type"),
        "description": field.get("description"),
        "options": field.get("options"),
    }


def normalize_view(view: dict[str, Any]) -> dict[str, Any]:
    """One saved view: its id, name and kind (grid, kanban, ...).

    Args:
        view (dict[str, Any]): a schema view.
    """
    return {
        "view_id": view.get("id"),
        "view_name": view.get("name"),
        "type": view.get("type"),
    }


def normalize_table(table: dict[str, Any], base_id: str) -> dict[str, Any]:
    """table.json: the column schema and the saved views.

    Args:
        table (dict[str, Any]): a schema table.
        base_id (str): the base holding it.
    """
    return {
        "table_id": table.get("id"),
        "table_name": table.get("name"),
        "base_id": base_id,
        "description": table.get("description"),
        "primary_field_id": table.get("primaryFieldId"),
        "fields": [normalize_field(f) for f in as_rows(table.get("fields"))],
        "views": [normalize_view(v) for v in as_rows(table.get("views"))],
    }


def normalize_record(record: dict[str, Any]) -> dict[str, Any]:
    """One records.jsonl row.

    ``fields`` is Airtable's cell map, keyed by field name and passed
    through untouched: an empty cell is absent (Airtable never sends
    one), a link is a list of record ids, and an attachment's url is
    the API's own, which expires two hours after it was fetched.

    Args:
        record (dict[str, Any]): a listed record.
    """
    return {
        "record_id": record.get("id"),
        "created_time": record.get("createdTime"),
        "fields": as_row(record.get("fields")),
    }


def normalize_comment(comment: dict[str, Any]) -> dict[str, Any]:
    """One comment on a record, with its author flattened.

    Args:
        comment (dict[str, Any]): a listed or created comment.
    """
    who = as_row(comment.get("author"))
    return {
        "comment_id": comment.get("id"),
        "author_id": who.get("id"),
        "author_email": who.get("email"),
        "author_name": who.get("name"),
        "text": comment.get("text"),
        "created_time": comment.get("createdTime"),
        "last_updated_time": comment.get("lastUpdatedTime"),
    }


def normalize_deletion(row: dict[str, Any]) -> dict[str, Any]:
    """One deleted record, as the delete answer names it.

    Args:
        row (dict[str, Any]): an ``{id, deleted}`` answer row.
    """
    return {"record_id": row.get("id"), "deleted": row.get("deleted")}


def records_jsonl(records: list[dict[str, Any]]) -> bytes:
    """Render records one per line, in the order they were listed.

    Args:
        records (list[dict[str, Any]]): listed records.
    """
    return jsonl_bytes([normalize_record(r) for r in records])


def deletions_jsonl(rows: list[dict[str, Any]]) -> bytes:
    """Render deleted records one per line, in the order they were deleted.

    Args:
        rows (list[dict[str, Any]]): delete answer rows.
    """
    return jsonl_bytes([normalize_deletion(r) for r in rows])
