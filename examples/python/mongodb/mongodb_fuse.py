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

import json
import os
import sys
import time

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.mongodb import MongoDBConfig, MongoDBResource

load_dotenv(".env.development")

DB = "mirage_test"
COLL = "heterogeneous"
VIEW = "high_rated_films"

config = MongoDBConfig(uri=os.environ["MONGODB_URI"], databases=[DB])
resource = MongoDBResource(config=config)

with Workspace(
    {"/mongodb/": resource},
        mode=MountMode.READ,
        fuse=True,
) as ws:
    time.sleep(1)
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- listdir() root (databases) ---")
    for db in os.listdir(f"{mp}/mongodb"):
        print(f"  {db}")

    print(f"\n--- listdir() /mongodb/{DB} (entities) ---")
    for entry in os.listdir(f"{mp}/mongodb/{DB}"):
        print(f"  {entry}")

    print(f"\n--- listdir() /mongodb/{DB}/collections ---")
    for col in os.listdir(f"{mp}/mongodb/{DB}/collections"):
        print(f"  {col}")

    print(f"\n--- listdir() /mongodb/{DB}/views ---")
    for v in os.listdir(f"{mp}/mongodb/{DB}/views"):
        print(f"  {v}")

    print(f"\n--- listdir() /mongodb/{DB}/collections/{COLL} (entity) ---")
    for entry in os.listdir(f"{mp}/mongodb/{DB}/collections/{COLL}"):
        print(f"  {entry}")

    print("\n--- open() database.json ---")
    with open(f"{mp}/mongodb/{DB}/database.json") as f:
        db_meta = json.loads(f.read())
    print(f"  collections: {len(db_meta.get('collections', []))}")
    print(f"  views: {len(db_meta.get('views', []))}")

    print(f"\n--- open() schema.json for {COLL} ---")
    with open(f"{mp}/mongodb/{DB}/collections/{COLL}/schema.json") as f:
        schema = json.loads(f.read())
    print(f"  kind: {schema.get('kind')}")
    print(f"  fields: {len(schema.get('fields', []))}")
    print(f"  indexes: {len(schema.get('indexes', []))}")

    print(f"\n--- open() + read documents.jsonl for {COLL} ---")
    path = f"{mp}/mongodb/{DB}/collections/{COLL}/documents.jsonl"
    with open(path) as f:
        text = f.read().strip()
    lines = [ln for ln in text.splitlines() if ln.strip()]
    print(f"  documents: {len(lines)}")
    for line in lines[:3]:
        doc = json.loads(line)
        print(f"  {doc.get('title', '?')}")

    print(f"\n--- open() + read view documents for {VIEW} ---")
    view_path = f"{mp}/mongodb/{DB}/views/{VIEW}/documents.jsonl"
    with open(view_path) as f:
        view_text = f.read().strip()
    view_lines = [ln for ln in view_text.splitlines() if ln.strip()]
    print(f"  documents: {len(view_lines)}")
    for line in view_lines[:3]:
        doc = json.loads(line)
        print(f"  {doc.get('title', '?')} (rating={doc.get('rating', '?')})")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and try:")
    print(f">>>   ls {mp}/mongodb/{DB}/collections/")
    print(
        f">>>   head -n 3 {mp}/mongodb/{DB}/collections/{COLL}/documents.jsonl"
    )
    if sys.stdin.isatty():
        print(">>> Press Enter to unmount and exit...")
        input()
    else:
        print(">>> (non-interactive: unmounting now)")

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, "
          f"{total} bytes transferred")
