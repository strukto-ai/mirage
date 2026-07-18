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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.core.lancedb.query import search_rows
from mirage.core.lancedb.render import render_card
from mirage.resource.lancedb.config import LanceDBConfig
from mirage.types import PathSpec


def _target_table(paths: list[PathSpec], config: LanceDBConfig) -> str | None:
    if config.table:
        return config.table
    for path in paths:
        raw = path.mount_path if isinstance(path, PathSpec) else path
        key = raw.strip("/")
        if key:
            return key.split("/")[0]
    return None


def _canonical_path(row: dict[str, Any], config: LanceDBConfig, table: str,
                    mount_prefix: str) -> str:
    segs: list[str] = []
    if not config.table:
        segs.append(str(table))
    for column in config.group_by:
        if column in row and row[column] is not None:
            segs.append(str(row[column]))
    segs.append(f"{row[config.id_column]}.md")
    prefix = mount_prefix.rstrip("/")
    return prefix + "/" + "/".join(segs)


def _block(row: dict[str, Any], config: LanceDBConfig, table: str,
           mount_prefix: str) -> str:
    path = _canonical_path(row, config, table, mount_prefix)
    distance = row.get("_distance")
    header = path if distance is None else f"{path}:{float(distance):.4f}"
    body_row = {k: v for k, v in row.items() if k != "_distance"}
    content = render_card(body_row, config).decode().rstrip("\n")
    return f"{header}\n{content}"


async def search_rows_output(
    accessor: LanceDBAccessor,
    query: str,
    paths: list[PathSpec],
    top_k: int,
    threshold: float,
    mount_prefix: str,
) -> bytes:
    if not query:
        raise ValueError("search: query is required")
    if top_k <= 0:
        raise ValueError("search: top-k must be positive")
    table = _target_table(paths, accessor.config)
    if table is None:
        raise FileNotFoundError("search: no table to search")
    rows = await search_rows(accessor, table, query, top_k)
    blocks: list[str] = []
    for row in rows:
        distance = row.get("_distance")
        if threshold > 0 and distance is not None and float(
                distance) > threshold:
            continue
        blocks.append(_block(row, accessor.config, table, mount_prefix))
    if not blocks:
        return b""
    return ("\n".join(blocks) + "\n").encode()
