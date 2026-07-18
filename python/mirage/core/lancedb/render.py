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

from mirage.resource.lancedb.config import LanceDBConfig

_SKIP_KEYS = {"_distance", "_rowid", "_score"}


def render_card(row: dict[str, Any], config: LanceDBConfig) -> bytes:
    lines: list[str] = []
    title = row.get(config.title_column) if config.title_column else None
    if title is not None:
        lines.append(f"# {title}")
        lines.append("")
    for key, value in row.items():
        if key in _SKIP_KEYS:
            continue
        if key == config.vector_column or key == config.blob_column:
            continue
        lines.append(f"{key}: {value}")
    if config.blob_column and config.id_column in row:
        lines.append(f"blob: {row[config.id_column]}.{config.blob_ext}")
    distance = row.get("_distance")
    if distance is not None:
        lines.append(f"score: {float(distance):.4f}")
    return ("\n".join(lines) + "\n").encode()
