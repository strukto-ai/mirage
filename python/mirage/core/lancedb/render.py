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

from mirage.core.lancedb.types import LanceRow
from mirage.core.render.json import value_text
from mirage.vfs.lancedb.config import LanceDBConfig

_SKIP_KEYS = {"_distance", "_rowid", "_score"}


def _is_json(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int, float)):
        return True
    if isinstance(value, list):
        return all(_is_json(item) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _is_json(item)
            for key, item in value.items()
        )
    return False


def cell_text(value: Any) -> str:
    """One column value as the card and the tree spell it.

    A JSON value spells as ``value_text`` does, so both hosts print one
    card (``true``, ``null``, ``1.5``); a value JSON cannot hold, such as
    an Arrow timestamp or bytes, falls back to ``str``.

    Args:
        value (Any): One decoded column value.
    """
    return value_text(value) if _is_json(value) else str(value)


def render_card(row: LanceRow, config: LanceDBConfig) -> bytes:
    lines: list[str] = []
    title = row.get(config.title_column) if config.title_column else None
    if title is not None:
        lines.append(f"# {cell_text(title)}")
        lines.append("")
    for key, value in row.items():
        if key in _SKIP_KEYS:
            continue
        if key == config.vector_column or key == config.blob_column:
            continue
        lines.append(f"{key}: {cell_text(value)}")
    if config.blob_column and config.id_column in row:
        lines.append(
            f"blob: {cell_text(row[config.id_column])}.{config.blob_ext}"
        )
    return ("\n".join(lines) + "\n").encode()
