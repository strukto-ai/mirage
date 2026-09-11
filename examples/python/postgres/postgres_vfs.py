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

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.postgres import PostgresConfig, PostgresResource

load_dotenv(".env.development")

config = PostgresConfig(
    dsn=os.environ["POSTGRES_DSN"],
    max_read_rows=200,
    max_read_bytes=1024 * 1024,
)
resource = PostgresResource(config=config)


async def main():
    with Workspace({"/pg/": resource}, mode=MountMode.READ) as ws:
        print("=== VFS MODE: open() reads from Postgres ===\n")

        print("--- os.listdir(/pg) — root entries ---")
        for e in os.listdir("/pg"):
            print(f"  {e}")

        print("\n--- read /pg/database.json ---")
        with open("/pg/database.json") as f:
            db_json = json.loads(f.read())
        print(f"  database: {db_json['database']}")
        print(f"  schemas: {db_json['schemas']}")
        print(f"  tables: {len(db_json['tables'])} | "
              f"views: {len(db_json['views'])} | "
              f"relationships: {len(db_json['relationships'])}")

        if "public" not in db_json["schemas"]:
            print("\nno public schema")
            return

        print("\n--- os.listdir(/pg/public) ---")
        for e in os.listdir("/pg/public"):
            print(f"  {e}")

        print("\n--- os.listdir(/pg/public/tables) ---")
        tables = os.listdir("/pg/public/tables")
        for t in tables[:5]:
            print(f"  {t}")
        if len(tables) > 5:
            print(f"  ... ({len(tables)} total)")

        if not tables:
            print("no tables in public")
            return

        target = tables[0]
        entity_dir = f"/pg/public/tables/{target}"

        print(f"\n--- os.listdir({entity_dir}) ---")
        for e in os.listdir(entity_dir):
            print(f"  {e}")

        sch_path = f"{entity_dir}/schema.json"
        print(f"\n--- read {sch_path} ---")
        with open(sch_path) as f:
            sch = json.loads(f.read())
        print(f"  name={sch['name']} kind={sch['kind']}")
        print(f"  columns: {[c['name'] for c in sch['columns'][:6]]}" +
              (" ..." if len(sch["columns"]) > 6 else ""))
        print(f"  primary_key: {sch['primary_key']}")
        print(f"  foreign_keys: {len(sch['foreign_keys'])}")
        print(f"  row_count_estimate: {sch['row_count_estimate']}")

        rows_path = f"{entity_dir}/rows.jsonl"
        print("\n--- open() rows.jsonl (may hit size guard) ---")
        try:
            with open(rows_path) as f:
                content = f.read()
            lines = [ln for ln in content.strip().split("\n") if ln.strip()]
            print(f"  rows returned: {len(lines)}")
            for line in lines[:3]:
                doc = json.loads(line)
                print(f"  {json.dumps(doc)[:120]}")
        except Exception as exc:
            print(f"  guard fired: {str(exc)[:160]}")

        print("\n--- bash history ---")
        with open("/.bash_history") as f:
            for i, line in enumerate(f):
                if i >= 6:
                    break
                print(f"  {line.rstrip()[:120]}")

        records = ws.fs.records
        total = sum(r.bytes for r in records)
        print(f"\nStats: {len(records)} ops, {total} bytes transferred")

    await resource.accessor.close()


asyncio.run(main())
