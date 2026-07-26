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

import asyncio
from typing import Any

from pymongo import AsyncMongoClient

from mirage.core.mongodb._client import list_collections
from mirage.core.mongodb.stream import render_doc
from mirage.core.mongodb.types import PRIMARY_KEY, EntityKind


def _collect_string_paths(value, prefix: str, out: set[str]) -> None:
    if isinstance(value, dict):
        for k, v in value.items():
            sub = f"{prefix}.{k}" if prefix else k
            _collect_string_paths(v, sub, out)
        return
    if isinstance(value, str) and prefix and prefix != PRIMARY_KEY:
        out.add(prefix)


async def _sampled_string_paths(col, sample_size: int = 100) -> list[str]:
    paths: set[str] = set()
    async for doc in await col.aggregate([{"$sample": {"size": sample_size}}]):
        _collect_string_paths(doc, "", paths)
    return sorted(paths)


async def search_collection(
    client: AsyncMongoClient[Any],
    database: str,
    collection: str,
    pattern: str,
    limit: int = 100,
) -> list[dict[str, Any]]:
    db = client[database]
    col = db[collection]
    # Always $regex, never $text. A $text index matches whole words and
    # stems them, while grep matches substrings, and these rows are
    # returned as the grep output without a local re-scan: $text would
    # both miss `foo` inside `foobar` and match stems the pattern never
    # had. $regex takes the pattern as written.
    paths = await _sampled_string_paths(col)
    if not paths:
        return []
    filter_expr: dict[str, Any] = {
        "$or": [{
            p: {
                "$regex": pattern,
                "$options": "i"
            }
        } for p in paths]
    }
    cursor = col.find(filter_expr).limit(limit)
    return await cursor.to_list(length=limit)


async def search_database(
    client: AsyncMongoClient[Any],
    database: str,
    pattern: str,
    limit: int,
) -> list[tuple[str, str, list[dict[str, Any]]]]:
    collections = await list_collections(client,
                                         database,
                                         kind=EntityKind.COLLECTION)
    tasks = [
        search_collection(client, database, col, pattern, limit=limit)
        for col in collections
    ]
    results_per_col = await asyncio.gather(*tasks)
    return [(database, col, docs)
            for col, docs in zip(collections, results_per_col) if docs]


def format_grep_results(
    results: list[tuple[str, str, list[dict[str, Any]]]]
) -> list[str]:  # noqa: E125
    lines: list[str] = []
    for db_name, col_name, docs in results:
        path = f"{db_name}/collections/{col_name}/documents.jsonl"
        for doc in docs:
            line_json = render_doc(doc)
            lines.append(f"{path}:{line_json}")
    return lines
