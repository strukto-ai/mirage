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

from dotenv import load_dotenv

from mirage import Mount, MountMode, Workspace
from mirage.resource.postgres import PostgresConfig, PostgresResource

load_dotenv(".env.development")

config = PostgresConfig(
    dsn=os.environ["POSTGRES_DSN"],
    max_read_rows=1_000_000,
    max_read_bytes=512 * 1024 * 1024,
)
resource = PostgresResource(config=config)

with Workspace({"/pg/": Mount(resource, mode=MountMode.READ,
                              fuse=True)}) as ws:
    mp = ws.fuse_mountpoint

    print(f"=== FUSE MODE: mounted at {mp} ===\n")

    print("--- os.listdir() root ---")
    for e in os.listdir(mp):
        print(f"  {e}")

    print("\n--- read database.json ---")
    with open(f"{mp}/database.json") as f:
        db_json = json.loads(f.read())
    print(f"  database: {db_json['database']}")
    print(f"  schemas: {db_json['schemas']}")
    print(f"  tables: {len(db_json['tables'])} | "
          f"views: {len(db_json['views'])} | "
          f"relationships: {len(db_json['relationships'])}")

    if "public" in db_json["schemas"]:
        tables = os.listdir(f"{mp}/public/tables")
        print(f"\n--- public.tables: {len(tables)} entries ---")
        for t in tables[:5]:
            print(f"  {t}")

        if tables:
            target = tables[0]
            entity_dir = f"{mp}/public/tables/{target}"

            print(f"\n--- ls {entity_dir} ---")
            for e in os.listdir(entity_dir):
                print(f"  {e}")

            sch_path = f"{entity_dir}/schema.json"
            print(f"\n--- read {sch_path} ---")
            with open(sch_path) as f:
                sch = json.loads(f.read())
            print(f"  name={sch['name']} kind={sch['kind']}")
            print(f"  columns: {len(sch['columns'])}")
            print(f"  primary_key: {sch['primary_key']}")
            print(f"  rows: {sch['row_count_estimate']}")

            rows_path = f"{entity_dir}/rows.jsonl"
            print("\n--- read rows.jsonl (may hit size guard) ---")
            try:
                with open(rows_path) as f:
                    text = f.read().strip()
                if text:
                    lines = text.splitlines()
                    print(f"  rows: {len(lines)}")
                    for line in lines[:3]:
                        try:
                            doc = json.loads(line)
                            print(f"  {json.dumps(doc)[:120]}")
                        except json.JSONDecodeError:
                            print(f"  {line[:120]}")
                else:
                    print("  (empty)")
            except Exception as exc:
                print(f"  guard fired: {str(exc)[:160]}")

    print(f"\n>>> FUSE mounted at: {mp}")
    print(">>> Open another terminal and try:")
    print(f">>>   ls {mp}/")
    print(f">>>   cat {mp}/database.json | jq .schemas")
    print(f">>>   head -n 3 {mp}/public/tables/<table>/rows.jsonl")
    print(">>> Press Enter to unmount and exit...")
    input()

    records = ws.ops.records
    total = sum(r.bytes for r in records)
    print(f"\nStats: {len(records)} ops, {total} bytes transferred")
