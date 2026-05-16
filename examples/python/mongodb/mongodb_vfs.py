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
import json
import os
import sys

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.mongodb import MongoDBConfig, MongoDBResource

load_dotenv(".env.development")

DB = "mirage_test"
COLL = "heterogeneous"
VIEW = "high_rated_films"

config = MongoDBConfig(uri=os.environ["MONGODB_URI"], databases=[DB])
resource = MongoDBResource(config=config)


async def main():
    with Workspace({"/mongodb/": resource}, mode=MountMode.READ) as ws:
        vos = sys.modules["os"]
        print("=== VFS MODE: open() reads from MongoDB ===\n")

        print("--- listdir() root (databases) ---")
        for db in vos.listdir("/mongodb"):
            print(f"  {db}")

        print(f"\n--- listdir() /mongodb/{DB} (entities) ---")
        for entry in vos.listdir(f"/mongodb/{DB}"):
            print(f"  {entry}")

        print(f"\n--- listdir() /mongodb/{DB}/collections ---")
        collections = vos.listdir(f"/mongodb/{DB}/collections")
        for col in collections:
            print(f"  {col}")

        print(f"\n--- listdir() /mongodb/{DB}/views ---")
        views = vos.listdir(f"/mongodb/{DB}/views")
        for v in views:
            print(f"  {v}")

        print(f"\n--- listdir() /mongodb/{DB}/collections/{COLL} (entity) ---")
        for entry in vos.listdir(f"/mongodb/{DB}/collections/{COLL}"):
            print(f"  {entry}")

        print("\n--- open() database.json ---")
        with open(f"/mongodb/{DB}/database.json") as f:
            db_meta = json.loads(f.read())
        print(f"  collections: {len(db_meta.get('collections', []))}")
        print(f"  views: {len(db_meta.get('views', []))}")

        print(f"\n--- open() schema.json for {COLL} ---")
        with open(f"/mongodb/{DB}/collections/{COLL}/schema.json") as f:
            schema = json.loads(f.read())
        print(f"  kind: {schema.get('kind')}")
        print(f"  fields: {len(schema.get('fields', []))}")
        print(f"  indexes: {len(schema.get('indexes', []))}")

        print(f"\n--- open() + read documents.jsonl for {COLL} ---")
        path = f"/mongodb/{DB}/collections/{COLL}/documents.jsonl"
        with open(path) as f:
            content = f.read()
        lines = [ln for ln in content.strip().split("\n") if ln.strip()]
        print(f"  documents: {len(lines)}")
        for line in lines[:3]:
            doc = json.loads(line)
            print(f"  [{doc['_id']['$oid']}] {doc.get('title', '?')}")

        print(f"\n--- open() + read view documents for {VIEW} ---")
        view_path = f"/mongodb/{DB}/views/{VIEW}/documents.jsonl"
        with open(view_path) as f:
            view_content = f.read()
        view_lines = [
            ln for ln in view_content.strip().split("\n") if ln.strip()
        ]
        print(f"  documents: {len(view_lines)}")
        for line in view_lines[:3]:
            doc = json.loads(line)
            title = doc.get("title", "?")
            rating = doc.get("rating", "?")
            print(f"  {title} (rating={rating})")

        print("\n--- session observer ---")
        day_folders = vos.listdir("/.sessions")
        log_entries = vos.listdir(day_folders[0]) if day_folders else []
        for e in log_entries[:3]:
            print(f"  {e}")

        records = ws.ops.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, "
              f"{total} bytes transferred")


asyncio.run(main())
