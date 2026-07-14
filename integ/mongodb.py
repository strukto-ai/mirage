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

from cases import run_not_found, run_provision_probe, run_sed_readonly_probe
from pymongo import AsyncMongoClient

from mirage import MountMode, Workspace
from mirage.resource.mongodb import MongoDBConfig, MongoDBResource
from mirage.types import CommandSafeguard

MONGODB_URI = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")
DB = "mirage_integ"
MOUNT = "/mongodb"

BOOKS = [
    {
        "_id": 1,
        "title": "alpha",
        "author": "ada",
        "year": 2020,
        "tags": ["fiction", "classic"],
        "rating": 4.5,
    },
    {
        "_id": 2,
        "title": "beta",
        "author": "ben",
        "year": 2021,
        "tags": ["fiction"],
        "rating": 3.2,
    },
    {
        "_id": 3,
        "title": "gamma",
        "author": "cara",
        "year": 2022,
        "rating": 5.0,
    },
    {
        "_id": 4,
        "title": "delta",
        "author": "ada",
        "year": 2023,
        "tags": ["history"],
        "rating": 4.0,
    },
    {
        "_id": 5,
        "title": "epsilon",
        "author": "ben",
        "year": 2024,
        "rating": 2.5,
    },
]

AUTHORS = [
    {
        "_id": 1,
        "name": "ada",
        "books": 2
    },
    {
        "_id": 2,
        "name": "ben",
        "books": 2
    },
    {
        "_id": 3,
        "name": "cara",
        "books": 1
    },
]

CASES: list[tuple[str, str]] = [
    ("ls_root", f"ls {MOUNT}/"),
    ("ls_db", f"ls {MOUNT}/{DB}/"),
    ("ls_collections", f"ls {MOUNT}/{DB}/collections/"),
    ("ls_views", f"ls {MOUNT}/{DB}/views/"),
    ("ls_entity", f"ls {MOUNT}/{DB}/collections/books/"),
    ("tree", f"tree -L 3 {MOUNT}/{DB}/"),
    ("cat_database_json", f"cat {MOUNT}/{DB}/database.json"),
    ("cat_schema_json", f"cat {MOUNT}/{DB}/collections/books/schema.json"),
    ("cat_docs", f"cat {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("head_2", f"head -n 2 {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("tail_2", f"tail -n 2 {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("wc_l_books", f"wc -l {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("wc_default_books", f"wc {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("wc_l_authors",
     f"wc -l {MOUNT}/{DB}/collections/authors/documents.jsonl"),
    ("stat_docs", f"stat {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("grep_c_title",
     f"grep -c title {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("grep_ada", f"grep ada {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("grep_e_multi",
     f"grep -n -e ada -e ben {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("grep_r_e_multi",
     f"grep -r -e alpha -e beta {MOUNT}/{DB}/collections/books"),
    ("grep_db_scope", f"grep ada {MOUNT}/{DB}/"),
    ("grep_root_scope", f"grep ada {MOUNT}/"),
    ("rg_db_scope", f"rg ben {MOUNT}/{DB}/"),
    ("rg_e_multi", f"rg -e gamma -e cara {MOUNT}/{DB}/collections/books"),
    ("find_docs", f"find {MOUNT}/{DB}/ -name documents.jsonl"),
    ("find_schema", f"find {MOUNT}/{DB}/ -name schema.json"),
    ("jq_titles",
     f"jq '.title' {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("pipe_grep_c",
     f"cat {MOUNT}/{DB}/collections/books/documents.jsonl | grep -c fiction"),
    ("cat_view_docs", f"cat {MOUNT}/{DB}/views/recent_books/documents.jsonl"),
    ("wc_l_view", f"wc -l {MOUNT}/{DB}/views/recent_books/documents.jsonl"),

    # ----- safeguard: per-mount cap on cat (set to 2 lines below) -----
    ("safeguard_cat_truncates",
     f"cat {MOUNT}/{DB}/collections/books/documents.jsonl"),
    ("safeguard_cat_pipe_uncapped",
     f"cat {MOUNT}/{DB}/collections/books/documents.jsonl | wc -l"),
    # symlink to the database meta file (namespace state; read-only backend)
    ("sym_ln", f"ln -s {MOUNT}/{DB}/database.json {MOUNT}/meta_link"),
    ("sym_readlink", f"readlink {MOUNT}/meta_link"),
    ("sym_cat", f"cat {MOUNT}/meta_link"),
    ("sym_ls", f"ls -F {MOUNT} | grep meta_link"),
    ("sym_rm", f"rm {MOUNT}/meta_link && ls {MOUNT}"),
]


async def _seed(client: AsyncMongoClient) -> None:
    await client.drop_database(DB)
    db = client[DB]
    await db["books"].insert_many([dict(d) for d in BOOKS])
    await db["authors"].insert_many([dict(d) for d in AUTHORS])
    await db.create_collection(
        "recent_books",
        viewOn="books",
        pipeline=[{
            "$match": {
                "year": {
                    "$gte": 2022
                }
            }
        }],
    )


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")
    if name.startswith("safeguard_"):
        err = await result.stderr_str()
        if err:
            print(err, end="" if err.endswith("\n") else "\n")


async def _follow_once(ws: Workspace, cmd: str) -> str:
    result = await ws.execute(cmd)
    return await result.stdout_str()


async def _insert_until_done(client: AsyncMongoClient,
                             task: "asyncio.Task[str]") -> None:
    i = 0
    while not task.done():
        i += 1
        await client[DB]["books"].insert_one({
            "_id": 100 + i,
            "title": "live_insert",
        })
        await asyncio.sleep(0.5)


async def _run_follow(ws: Workspace, client: AsyncMongoClient) -> None:
    name = "tail_f_change_stream"
    cmd = (f"tail -f {MOUNT}/{DB}/collections/books/documents.jsonl "
           "| head -n 1")
    task = asyncio.create_task(_follow_once(ws, cmd))
    inserter = asyncio.create_task(_insert_until_done(client, task))
    try:
        out = await asyncio.wait_for(task, timeout=30)
    finally:
        inserter.cancel()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")


def _set_cat_safeguard(ws: Workspace, max_lines: int) -> None:
    sg = CommandSafeguard(max_lines=max_lines)
    mounts = list(ws._registry._mounts)
    for m in mounts:
        m.command_safeguards["cat"] = sg


async def main() -> None:
    seed_client = AsyncMongoClient(MONGODB_URI)
    try:
        await _seed(seed_client)
    finally:
        await seed_client.close()
    resource = MongoDBResource(
        config=MongoDBConfig(uri=MONGODB_URI, databases=[DB]))
    ws = Workspace({MOUNT: resource}, mode=MountMode.READ)
    for name, cmd in CASES:
        if name == "safeguard_cat_truncates":
            _set_cat_safeguard(ws, max_lines=2)
        await _run(ws, name, cmd)
    await run_not_found(ws, MOUNT)
    await run_provision_probe(
        ws, f"{MOUNT}/{DB}/collections/books/documents.jsonl")
    await run_sed_readonly_probe(
        ws, f"{MOUNT}/{DB}/collections/books/documents.jsonl")
    live_client = AsyncMongoClient(MONGODB_URI)
    try:
        await _run_follow(ws, live_client)
    finally:
        await live_client.close()


if __name__ == "__main__":
    asyncio.run(main())
