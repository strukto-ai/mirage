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


def page_dirname(page: dict[str, Any]) -> str:
    title = extract_title(page)
    label = sanitize_name(title) if title else "untitled"
    return f"{label}__{page['id']}"


def database_dirname(database: dict[str, Any]) -> str:
    title = extract_database_title(database)
    label = sanitize_name(title) if title else "untitled"
    return f"{label}__{database['id']}"


def extract_title(page: dict[str, Any]) -> str:
    props = page.get("properties", {})
    for prop in props.values():
        if prop.get("type") == "title":
            title_items = prop.get("title", [])
            return "".join(item.get("plain_text", "") for item in title_items)
    return ""


def extract_database_title(database: dict[str, Any]) -> str:
    title_items = database.get("title", [])
    return "".join(item.get("plain_text", "") for item in title_items)
