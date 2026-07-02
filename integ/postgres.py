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

import asyncpg
from cases import run_not_found, run_provision_probe

from mirage import MountMode, Workspace
from mirage.resource.postgres import PostgresConfig, PostgresResource
from mirage.types import CommandSafeguard

DSN = os.environ.get("POSTGRES_DSN",
                     "postgres://mirage:mirage@localhost:55432/mirage_integ")
MOUNT = "/pg"

BOOKS = [
    (1, "alpha", "ada", 2020, 4.5),
    (2, "beta", "ben", 2021, 3.2),
    (3, "gamma", "cara", 2022, 5.0),
    (4, "delta", "ada", 2023, 4.0),
    (5, "epsilon", "ben", 2024, 2.5),
]

AUTHORS = [
    (1, "ada", 2),
    (2, "ben", 2),
    (3, "cara", 1),
]

CASES: list[tuple[str, str]] = [
    ("ls_root", f"ls {MOUNT}/"),
    ("ls_schema", f"ls {MOUNT}/public/"),
    ("ls_tables", f"ls {MOUNT}/public/tables/"),
    ("ls_views", f"ls {MOUNT}/public/views/"),
    ("ls_entity", f"ls {MOUNT}/public/tables/books/"),
    ("tree", f"tree -L 3 {MOUNT}/public/"),
    ("cat_schema_json", f"cat {MOUNT}/public/tables/books/schema.json"),
    ("cat_rows", f"cat {MOUNT}/public/tables/books/rows.jsonl"),
    ("head_2", f"head -n 2 {MOUNT}/public/tables/books/rows.jsonl"),
    ("tail_2", f"tail -n 2 {MOUNT}/public/tables/books/rows.jsonl"),
    ("wc_l_books", f"wc -l {MOUNT}/public/tables/books/rows.jsonl"),
    ("wc_default_books", f"wc {MOUNT}/public/tables/books/rows.jsonl"),
    ("wc_l_authors", f"wc -l {MOUNT}/public/tables/authors/rows.jsonl"),
    ("stat_rows", f"stat {MOUNT}/public/tables/books/rows.jsonl"),
    ("grep_c_title", f"grep -c title {MOUNT}/public/tables/books/rows.jsonl"),
    ("grep_ada", f"grep ada {MOUNT}/public/tables/books/rows.jsonl"),
    ("grep_e_multi",
     f"grep -n -e ada -e ben {MOUNT}/public/tables/books/rows.jsonl"),
    ("grep_schema_scope", f"grep ada {MOUNT}/public/tables/"),
    ("rg_schema_scope", f"rg ben {MOUNT}/public/"),
    ("find_rows", f"find {MOUNT}/public/ -name rows.jsonl"),
    ("find_schema", f"find {MOUNT}/public/ -name schema.json"),
    ("jq_titles", f"jq '.title' {MOUNT}/public/tables/books/rows.jsonl"),
    ("pipe_grep_c",
     f"cat {MOUNT}/public/tables/books/rows.jsonl | grep -c ada"),
    ("cat_view_rows", f"cat {MOUNT}/public/views/recent_books/rows.jsonl"),
    ("wc_l_view", f"wc -l {MOUNT}/public/views/recent_books/rows.jsonl"),
    ("safeguard_cat_truncates", f"cat {MOUNT}/public/tables/books/rows.jsonl"),
    ("safeguard_cat_pipe_uncapped",
     f"cat {MOUNT}/public/tables/books/rows.jsonl | wc -l"),
    # symlink into the mount (namespace state; works on a read-only backend)
    ("sym_ln", f"ln -s {MOUNT}/public/tables/books/schema.json"
     f" {MOUNT}/meta_link"),
    ("sym_readlink", f"readlink {MOUNT}/meta_link"),
    ("sym_cat", f"cat {MOUNT}/meta_link"),
    ("sym_ls", f"ls -F {MOUNT} | grep meta_link"),
    ("sym_rm", f"rm {MOUNT}/meta_link && ls {MOUNT}"),
]


async def _seed(conn: asyncpg.Connection) -> None:
    await conn.execute("DROP VIEW IF EXISTS recent_books")
    await conn.execute("DROP TABLE IF EXISTS books")
    await conn.execute("DROP TABLE IF EXISTS authors")
    await conn.execute("CREATE TABLE books (id int PRIMARY KEY, title text, "
                       "author text, year int, rating double precision)")
    await conn.execute(
        "CREATE TABLE authors (id int PRIMARY KEY, name text, books int)")
    await conn.executemany(
        "INSERT INTO books (id, title, author, year, rating) "
        "VALUES ($1, $2, $3, $4, $5)", BOOKS)
    await conn.executemany(
        "INSERT INTO authors (id, name, books) VALUES ($1, $2, $3)", AUTHORS)
    await conn.execute(
        "CREATE VIEW recent_books AS SELECT * FROM books WHERE year >= 2022")
    await conn.execute("ANALYZE books")
    await conn.execute("ANALYZE authors")


async def _run(ws: Workspace, name: str, cmd: str) -> None:
    result = await ws.execute(cmd)
    out = await result.stdout_str()
    print(f"=== {name} ===")
    print(out, end="" if out.endswith("\n") else "\n")
    if name.startswith("safeguard_"):
        err = await result.stderr_str()
        if err:
            print(err, end="" if err.endswith("\n") else "\n")


def _set_cat_safeguard(ws: Workspace, max_lines: int) -> None:
    sg = CommandSafeguard(max_lines=max_lines)
    mounts = list(ws._registry._mounts)
    for m in mounts:
        m.command_safeguards["cat"] = sg


async def main() -> None:
    conn = await asyncpg.connect(DSN)
    try:
        await _seed(conn)
    finally:
        await conn.close()
    resource = PostgresResource(
        config=PostgresConfig(dsn=DSN, max_read_rows=200))
    ws = Workspace({MOUNT: resource}, mode=MountMode.READ)
    for name, cmd in CASES:
        if name == "safeguard_cat_truncates":
            _set_cat_safeguard(ws, max_lines=2)
        await _run(ws, name, cmd)
    await run_not_found(ws, MOUNT)
    await run_provision_probe(ws, f"{MOUNT}/public/tables/books/rows.jsonl")
    await resource.accessor.close()


if __name__ == "__main__":
    asyncio.run(main())
