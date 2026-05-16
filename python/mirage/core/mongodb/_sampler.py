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

import datetime as dt
from collections.abc import Iterable

from bson import Binary, Decimal128, Int64, ObjectId, Regex, Timestamp

from mirage.core.mongodb.types import PRIMARY_KEY, BsonTypeTag


def _bump(counts: dict[str, dict[str, int]], path: str, tag: str) -> None:
    counts.setdefault(path, {})
    counts[path][tag] = counts[path].get(tag, 0) + 1


def _scalar_tag(v) -> str:
    if isinstance(v, bool):
        return BsonTypeTag.BOOL
    if isinstance(v, Int64):
        return BsonTypeTag.LONG
    if isinstance(v, int):
        return BsonTypeTag.INT
    if isinstance(v, float):
        return BsonTypeTag.DOUBLE
    if isinstance(v, str):
        return BsonTypeTag.STRING
    if isinstance(v, ObjectId):
        return BsonTypeTag.OBJECT_ID
    if isinstance(v, Decimal128):
        return BsonTypeTag.DECIMAL
    if isinstance(v, dt.datetime):
        return BsonTypeTag.DATE
    if isinstance(v, Timestamp):
        return BsonTypeTag.TIMESTAMP
    if isinstance(v, Binary):
        return BsonTypeTag.BINARY
    if isinstance(v, Regex):
        return BsonTypeTag.REGEX
    if v is None:
        return BsonTypeTag.NULL
    return type(v).__name__


def _array_tag(items: Iterable) -> str:
    items = list(items)
    if not items:
        return BsonTypeTag.ARRAY
    if all(
            isinstance(x, (int, float)) and not isinstance(x, bool)
            for x in items):
        return f"array<{BsonTypeTag.DOUBLE}>({len(items)})"
    if all(isinstance(x, str) for x in items):
        return f"array<{BsonTypeTag.STRING}>"
    return BsonTypeTag.ARRAY


def _walk(value, prefix: str, counts: dict[str, dict[str, int]]) -> None:
    if isinstance(value, dict):
        if prefix:
            _bump(counts, prefix, BsonTypeTag.OBJECT)
        for k, v in value.items():
            _walk(v, f"{prefix}.{k}" if prefix else k, counts)
        return
    if isinstance(value, list):
        _bump(counts, prefix, _array_tag(value))
        return
    if prefix:
        _bump(counts, prefix, _scalar_tag(value))


async def sample_field_types(col, sample_size: int = 100) -> list[dict]:
    counts: dict[str, dict[str, int]] = {}
    total = 0
    async for doc in col.aggregate([{"$sample": {"size": sample_size}}]):
        total += 1
        _walk(doc, "", counts)
    if total == 0:
        return []
    fields: list[dict] = []
    for path, type_counts in sorted(counts.items()):
        if path == PRIMARY_KEY:
            continue
        presence_count = sum(type_counts.values())
        fields.append({
            "path": path,
            "presence": presence_count / total,
            "types": {
                t: c / total
                for t, c in type_counts.items()
            },
        })
    return fields
