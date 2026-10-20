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

from mirage import MountMode, Workspace
from mirage.vfs.airtable import AirtableConfig, AirtableVFS

load_dotenv(".env.development")

config = AirtableConfig(token=os.environ["AIRTABLE_TOKEN"])
vfs = AirtableVFS(config=config)


def main() -> None:
    with Workspace({"/airtable/": vfs}, mode=MountMode.READ):
        print("=== VFS MODE ===\n")
        bases = os.listdir("/airtable/bases")
        print("--- os.listdir() bases ---")
        for name in bases[:5]:
            print(f"  {name}")
        if not bases:
            return
        base = f"/airtable/bases/{bases[0]}"
        with open(f"{base}/base.json") as f:
            meta = json.load(f)
        print(f"\n--- {meta['base_name']}: {len(meta['tables'])} table(s) ---")
        for table in meta["tables"]:
            print(f"  {table['table_name']} ({table['table_id']})")
        tables = [n for n in os.listdir(base) if n != "base.json"]
        if not tables:
            return
        records = f"{base}/{tables[0]}/records.jsonl"
        print(f"\n--- first records of {tables[0]} ---")
        with open(records) as f:
            for _, line in zip(range(3), f):
                row = json.loads(line)
                print(f"  {row['record_id']}: {sorted(row['fields'])}")


if __name__ == "__main__":
    main()
