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
import datetime as dt
import os

from bson import Binary, Decimal128, Int64, ObjectId, Regex, Timestamp
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

DB_NAME = "mirage_test"

BSON_TYPE_DOCS = [
    {
        "_id": ObjectId("65f0000000000000000000a1"),
        "label": "scalars",
        "string": "hello",
        "int32": 42,
        "int64": Int64(2**40),
        "double": 3.14159,
        "bool": True,
        "null": None,
        "decimal": Decimal128("123456789.987654321"),
    },
    {
        "_id": ObjectId("65f0000000000000000000a2"),
        "label": "temporal",
        "date_utc": dt.datetime(2026,
                                5,
                                15,
                                12,
                                30,
                                45,
                                tzinfo=dt.timezone.utc),
        "timestamp": Timestamp(1715774400, 1),
    },
    {
        "_id": ObjectId("65f0000000000000000000a3"),
        "label": "binary_and_regex",
        "binary": Binary(b"\x00\x01\x02\x03\x04\xff\xfe"),
        "regex": Regex(r"^foo.*bar$", "i"),
    },
    {
        "_id": ObjectId("65f0000000000000000000a4"),
        "label": "nested",
        "metadata": {
            "tag": "alpha",
            "ratings": [4.5, 3.7, Decimal128("4.85")],
            "nested": {
                "depth": 2,
                "leaf": ObjectId("65f0000000000000000000b1")
            },
        },
    },
    {
        "_id": ObjectId("65f0000000000000000000a5"),
        "label": "arrays",
        "mixed_array":
        [1, "two", 3.0, True, None, {
            "inner": "value"
        }, [10, 20]],
        "string_array": ["alpha", "beta", "gamma"],
    },
]


def _heterogeneous_doc(i: int) -> dict:
    doc: dict = {"_id": ObjectId(), "i": i, "title": f"item-{i}"}
    if i % 3 == 0:
        doc["category"] = "alpha"
    if i % 5 == 0:
        doc["score"] = 100 + (i % 7)
    elif i % 5 == 1:
        doc["score"] = f"{100 + (i % 7)}"
    if i % 7 == 0:
        doc["metadata"] = {"tag": f"t{i % 4}", "active": i % 2 == 0}
    if i % 11 == 0:
        doc["tags"] = [f"tag-{j}" for j in range(i % 4)]
    return doc


def _embedding_doc(i: int, dim: int) -> dict:
    base = (i % 17) / 17.0
    vector = [round(base + (j % 13) / 1000.0, 6) for j in range(dim)]
    return {
        "_id": ObjectId(),
        "i": i,
        "title": f"embed-{i}",
        "vector": vector,
    }


def _text_doc(i: int) -> dict:
    topics = [
        "mongodb streaming", "vector database", "filesystem mount",
        "agent search", "BSON encoding"
    ]
    return {
        "_id":
        ObjectId(),
        "i":
        i,
        "title":
        f"article-{i}",
        "body":
        f"This is article {i} about {topics[i % len(topics)]}. "
        "It explores the topic in depth and provides examples.",
    }


def _view_source_doc(i: int) -> dict:
    return {
        "_id": ObjectId(),
        "year": 2000 + (i % 25),
        "title": f"film-{i}",
        "genre": ["drama", "comedy", "thriller", "scifi"][i % 4],
        "rating": round(5.0 + (i % 50) / 10.0, 1),
    }


async def seed_bson_types(db) -> int:
    await db.bson_types.insert_many(BSON_TYPE_DOCS)
    return len(BSON_TYPE_DOCS)


async def seed_heterogeneous(db, n: int = 500) -> int:
    docs = [_heterogeneous_doc(i) for i in range(n)]
    await db.heterogeneous.insert_many(docs)
    return len(docs)


async def seed_embeddings(db, n: int = 100, dim: int = 1024) -> int:
    docs = [_embedding_doc(i, dim) for i in range(n)]
    await db.embeddings.insert_many(docs)
    return len(docs)


async def seed_with_validator(db) -> int:
    await db.create_collection(
        "with_validator",
        validator={
            "$jsonSchema": {
                "bsonType": "object",
                "required": ["title", "year"],
                "properties": {
                    "title": {
                        "bsonType": "string"
                    },
                    "year": {
                        "bsonType": "int",
                        "minimum": 1900
                    },
                },
            }
        },
        validationLevel="moderate",
    )
    docs = [{
        "_id": ObjectId(),
        "title": f"book-{i}",
        "year": 2000 + i
    } for i in range(10)]
    await db.with_validator.insert_many(docs)
    return len(docs)


async def seed_text_indexed(db, n: int = 200) -> int:
    docs = [_text_doc(i) for i in range(n)]
    await db.text_indexed.insert_many(docs)
    await db.text_indexed.create_index([("title", "text"), ("body", "text")],
                                       name="title_body_text")
    return len(docs)


async def seed_view_source_and_view(db, n: int = 100) -> int:
    docs = [_view_source_doc(i) for i in range(n)]
    await db.view_source.insert_many(docs)
    await db.command({
        "create":
        "high_rated_films",
        "viewOn":
        "view_source",
        "pipeline": [
            {
                "$match": {
                    "rating": {
                        "$gte": 8.0
                    }
                }
            },
            {
                "$project": {
                    "title": 1,
                    "year": 1,
                    "rating": 1,
                    "_id": 1
                }
            },
        ],
    })
    return len(docs)


async def seed_streaming_large(db, n: int = 5000) -> int:
    batch_size = 1000
    total = 0
    for start in range(0, n, batch_size):
        end = min(start + batch_size, n)
        docs = [{
            "_id": ObjectId(),
            "i": i,
            "v": i * 2
        } for i in range(start, end)]
        await db.streaming_large.insert_many(docs)
        total += len(docs)
    return total


async def main() -> None:
    load_dotenv(".env.development")
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise SystemExit("MONGODB_URI not set. Check .env.development.")
    client = AsyncIOMotorClient(uri)
    db = client[DB_NAME]
    print(f"Dropping {DB_NAME}...")
    await client.drop_database(DB_NAME)
    print(f"Seeding {DB_NAME}...")
    n = await seed_bson_types(db)
    print(f"  bson_types: {n} docs")
    n = await seed_heterogeneous(db)
    print(f"  heterogeneous: {n} docs")
    n = await seed_embeddings(db)
    print(f"  embeddings: {n} docs")
    n = await seed_with_validator(db)
    print(f"  with_validator: {n} docs (with $jsonSchema)")
    n = await seed_text_indexed(db)
    print(f"  text_indexed: {n} docs (text index)")
    n = await seed_view_source_and_view(db)
    print(f"  view_source: {n} docs + high_rated_films view")
    n = await seed_streaming_large(db)
    print(f"  streaming_large: {n} docs")
    result = await db.command({"listCollections": 1})
    coll_info = result["cursor"]["firstBatch"]
    summary = sorted([(c["name"], c.get("type", "collection"))
                      for c in coll_info])
    print(f"\nFinal collections in {DB_NAME}:")
    for name, kind in summary:
        print(f"  {name:<22} ({kind})")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
