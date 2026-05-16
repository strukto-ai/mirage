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

from bson.json_util import RELAXED_JSON_OPTIONS, dumps
from motor.motor_asyncio import AsyncIOMotorClient

from mirage.core.mongodb._client import get_indexes, list_collections
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
    async for doc in col.aggregate([{"$sample": {"size": sample_size}}]):
        _collect_string_paths(doc, "", paths)
    return sorted(paths)


def _has_text_index(indexes: list[dict]) -> bool:
    return any("textIndexVersion" in idx for idx in indexes)


async def search_collection(
    client: AsyncIOMotorClient,
    database: str,
    collection: str,
    pattern: str,
    limit: int = 100,
) -> list[dict]:
    db = client[database]
    col = db[collection]
    indexes = await get_indexes(client, database, collection)
    if _has_text_index(indexes):
        filter_expr: dict = {"$text": {"$search": pattern}}
    else:
        paths = await _sampled_string_paths(col)
        if not paths:
            return []
        filter_expr = {
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
    client: AsyncIOMotorClient,
    database: str,
    pattern: str,
    limit: int,
) -> list[tuple[str, str, list[dict]]]:
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
        results: list[tuple[str, str, list[dict]]]) -> list[str]:  # noqa: E125
    lines: list[str] = []
    for db_name, col_name, docs in results:
        path = f"{db_name}/collections/{col_name}/documents.jsonl"
        for doc in docs:
            line_json = dumps(doc, json_options=RELAXED_JSON_OPTIONS)
            lines.append(f"{path}:{line_json}")
    return lines
