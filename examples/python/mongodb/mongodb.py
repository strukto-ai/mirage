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
import os

from dotenv import load_dotenv

from mirage import MountMode, Workspace
from mirage.resource.mongodb import MongoDBConfig, MongoDBResource

load_dotenv(".env.development")

DB = "mirage_test"
COLL_HET = "heterogeneous"
COLL_EMB = "embeddings"
COLL_TXT = "text_indexed"
VIEW = "high_rated_films"

config = MongoDBConfig(
    uri=os.environ["MONGODB_URI"],
    databases=[DB],
    elide_fields={f"{DB}.{COLL_EMB}": ["vector"]},
)
resource = MongoDBResource(config=config)


async def _run(ws, cmd):
    print(f"\n>>> {cmd}")
    r = await ws.execute(cmd)
    out = (await r.stdout_str()).strip()
    err = await r.stderr_str()
    if out:
        for line in out.splitlines()[:8]:
            print(f"  {line[:160]}")
        total = len(out.splitlines())
        if total > 8:
            print(f"  ... ({total} lines total)")
    if err:
        print(f"  [stderr] {err.strip()[:160]}")
    if not out and not err:
        print(f"  (empty, exit={r.exit_code})")
    return r


async def main():
    ws = Workspace({"/mongodb": resource}, mode=MountMode.READ)

    coll_doc = f"/mongodb/{DB}/collections/{COLL_HET}/documents.jsonl"
    coll_schema = f"/mongodb/{DB}/collections/{COLL_HET}/schema.json"
    emb_doc = f"/mongodb/{DB}/collections/{COLL_EMB}/documents.jsonl"
    text_doc = f"/mongodb/{DB}/collections/{COLL_TXT}/documents.jsonl"
    view_doc = f"/mongodb/{DB}/views/{VIEW}/documents.jsonl"
    view_schema = f"/mongodb/{DB}/views/{VIEW}/schema.json"
    db_json = f"/mongodb/{DB}/database.json"

    print("=" * 60)
    print("DIRECTORY LISTING")
    print("=" * 60)
    await _run(ws, "ls /mongodb/")
    await _run(ws, f"ls /mongodb/{DB}/")
    await _run(ws, f"ls /mongodb/{DB}/collections/")
    await _run(ws, f"ls /mongodb/{DB}/views/")
    await _run(ws, f"ls /mongodb/{DB}/collections/{COLL_HET}/")
    await _run(ws, f"tree -L 3 /mongodb/{DB}/")

    print("\n" + "=" * 60)
    print("CAT (database.json, schema.json, documents.jsonl)")
    print("=" * 60)
    await _run(ws, f'cat "{db_json}"')
    await _run(ws, f'cat "{coll_schema}"')
    await _run(ws, f'cat "{view_schema}"')

    print("\n" + "=" * 60)
    print("HEAD / TAIL / WC / STAT")
    print("=" * 60)
    await _run(ws, f'head -n 3 "{coll_doc}"')
    await _run(ws, f'tail -n 3 "{coll_doc}"')
    await _run(ws, f'wc -l "{coll_doc}"')
    await _run(ws, f'stat "{coll_doc}"')
    await _run(ws, f'head -n 2 "{view_doc}"')

    print("\n" + "=" * 60)
    print("ELIDE_FIELDS in action (embedding dropped from output)")
    print("=" * 60)
    await _run(ws, f'head -n 1 "{emb_doc}"')

    print("\n" + "=" * 60)
    print("GREP at every scope")
    print("=" * 60)
    await _run(ws, f'grep -c title "{coll_doc}"')
    await _run(ws, f'grep -m 3 title "{coll_doc}"')
    await _run(ws, f'grep mongodb "/mongodb/{DB}/collections/{COLL_TXT}/"')
    await _run(ws, f'grep mongodb "/mongodb/{DB}/"')
    await _run(ws, 'grep mongodb "/mongodb/"')

    print("\n" + "=" * 60)
    print("RG at db / root scope")
    print("=" * 60)
    await _run(ws, f'rg database "/mongodb/{DB}/"')
    await _run(ws, 'rg database "/mongodb/"')

    print("\n" + "=" * 60)
    print("JQ on documents.jsonl")
    print("=" * 60)
    await _run(ws, f'jq -r ".[] | .title" "{coll_doc}" | head -n 5')
    await _run(ws, f'jq -r \'.[] | ._id["$oid"]\' "{coll_doc}" | head -n 5')
    await _run(
        ws, f'jq -r ".[] | select(.year >= 2024) | .title" "{coll_doc}"'
        " | head -n 5")
    await _run(ws, f'jq -r ".[] | .body" "{text_doc}" | head -n 3')

    print("\n" + "=" * 60)
    print("FIND")
    print("=" * 60)
    await _run(ws, f'find "/mongodb/{DB}/" -name "schema.json"')
    await _run(ws, f'find "/mongodb/{DB}/" -name "documents.jsonl"')
    await _run(ws, f'find "/mongodb/{DB}/" -maxdepth 2')

    print("\n" + "=" * 60)
    print("CD + pwd + ls + relative path read")
    print("=" * 60)
    await ws.execute(f'cd "/mongodb/{DB}/collections/{COLL_HET}"')
    await _run(ws, "pwd")
    await _run(ws, "ls")
    await _run(ws, 'head -n 1 documents.jsonl')


if __name__ == "__main__":
    asyncio.run(main())
