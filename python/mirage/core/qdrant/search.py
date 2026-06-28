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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.core.qdrant.query import search_rows
from mirage.core.qdrant.render import render_json, render_text
from mirage.resource.qdrant.config import QdrantConfig
from mirage.types import PathSpec


def _content_ext(row: dict, config: QdrantConfig) -> str:
    if config.text_field and row.get(config.text_field) is not None:
        return "txt"
    return "json"


def _target_table(paths: list[PathSpec], config: QdrantConfig) -> str | None:
    if config.collection:
        return config.collection
    for path in paths:
        raw = path.strip_prefix if isinstance(path, PathSpec) else path
        key = raw.strip("/")
        if key:
            return key.split("/")[0]
    return None


def _canonical_path(row: dict, config: QdrantConfig, table: str,
                    mount_prefix: str) -> str:
    segs: list[str] = []
    if not config.collection:
        segs.append(str(table))
    for column in config.group_by:
        if column in row and row[column] is not None:
            segs.append(str(row[column]))
    segs.append(f"{row[config.id_field]}.{_content_ext(row, config)}")
    prefix = mount_prefix.rstrip("/")
    return prefix + "/" + "/".join(segs)


def _block(row: dict, config: QdrantConfig, table: str,
           mount_prefix: str) -> str:
    path = _canonical_path(row, config, table, mount_prefix)
    score = row.get("_score")
    header = path if score is None else f"{path}:{float(score):.4f}"
    body_row = {k: v for k, v in row.items() if k != "_score"}
    if _content_ext(row, config) == "txt":
        content = render_text(body_row, config).decode().rstrip("\n")
    else:
        content = render_json(body_row, config).decode().rstrip("\n")
    return f"{header}\n{content}"


async def search_rows_output(
    accessor: QdrantAccessor,
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
        score = row.get("_score")
        if threshold > 0 and score is not None and float(score) < threshold:
            continue
        blocks.append(_block(row, accessor.config, table, mount_prefix))
    if not blocks:
        return b""
    return ("\n".join(blocks) + "\n").encode()
