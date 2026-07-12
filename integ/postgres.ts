// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pg from "pg";
import {
  CommandSafeguard,
  MountMode,
  PostgresResource,
  Workspace,
} from "@struktoai/mirage-node";
import { runNotFound, runProvisionProbe } from "./cases.ts";

const DSN =
  process.env.POSTGRES_DSN ?? "postgres://mirage:mirage@localhost:55432/mirage_integ";
const MOUNT = "/pg";

const DEC = new TextDecoder();

const BOOKS: ReadonlyArray<readonly [number, string, string, number, number]> = [
  [1, "alpha", "ada", 2020, 4.5],
  [2, "beta", "ben", 2021, 3.2],
  [3, "gamma", "cara", 2022, 5.0],
  [4, "delta", "ada", 2023, 4.0],
  [5, "epsilon", "ben", 2024, 2.5],
];

const AUTHORS: ReadonlyArray<readonly [number, string, number]> = [
  [1, "ada", 2],
  [2, "ben", 2],
  [3, "cara", 1],
];

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["ls_root", `ls ${MOUNT}/`],
  ["ls_schema", `ls ${MOUNT}/public/`],
  ["ls_tables", `ls ${MOUNT}/public/tables/`],
  ["ls_views", `ls ${MOUNT}/public/views/`],
  ["ls_entity", `ls ${MOUNT}/public/tables/books/`],
  ["tree", `tree -L 3 ${MOUNT}/public/`],
  ["cat_schema_json", `cat ${MOUNT}/public/tables/books/schema.json`],
  ["cat_rows", `cat ${MOUNT}/public/tables/books/rows.jsonl`],
  ["head_2", `head -n 2 ${MOUNT}/public/tables/books/rows.jsonl`],
  ["tail_2", `tail -n 2 ${MOUNT}/public/tables/books/rows.jsonl`],
  ["wc_l_books", `wc -l ${MOUNT}/public/tables/books/rows.jsonl`],
  ["wc_default_books", `wc ${MOUNT}/public/tables/books/rows.jsonl`],
  ["wc_l_authors", `wc -l ${MOUNT}/public/tables/authors/rows.jsonl`],
  ["stat_rows", `stat ${MOUNT}/public/tables/books/rows.jsonl`],
  ["grep_c_title", `grep -c title ${MOUNT}/public/tables/books/rows.jsonl`],
  ["grep_ada", `grep ada ${MOUNT}/public/tables/books/rows.jsonl`],
  ["grep_e_multi", `grep -n -e ada -e ben ${MOUNT}/public/tables/books/rows.jsonl`],
  ["rg_e_multi", `rg -n -e ada -e ben ${MOUNT}/public/tables/books/rows.jsonl`],
  ["grep_schema_scope", `grep ada ${MOUNT}/public/tables/`],
  ["rg_schema_scope", `rg ben ${MOUNT}/public/`],
  ["find_rows", `find ${MOUNT}/public/ -name rows.jsonl`],
  ["find_schema", `find ${MOUNT}/public/ -name schema.json`],
  ["jq_titles", `jq '.title' ${MOUNT}/public/tables/books/rows.jsonl`],
  ["pipe_grep_c", `cat ${MOUNT}/public/tables/books/rows.jsonl | grep -c ada`],
  ["cat_view_rows", `cat ${MOUNT}/public/views/recent_books/rows.jsonl`],
  ["wc_l_view", `wc -l ${MOUNT}/public/views/recent_books/rows.jsonl`],
  ["safeguard_cat_truncates", `cat ${MOUNT}/public/tables/books/rows.jsonl`],
  ["safeguard_cat_pipe_uncapped", `cat ${MOUNT}/public/tables/books/rows.jsonl | wc -l`],
  // symlink into the mount (namespace state; works on a read-only backend)
  ["sym_ln", `ln -s ${MOUNT}/public/tables/books/schema.json ${MOUNT}/meta_link`],
  ["sym_readlink", `readlink ${MOUNT}/meta_link`],
  ["sym_cat", `cat ${MOUNT}/meta_link`],
  ["sym_ls", `ls -F ${MOUNT} | grep meta_link`],
  ["sym_rm", `rm ${MOUNT}/meta_link && ls ${MOUNT}`],
];

async function seed(client: pg.Client): Promise<void> {
  await client.query("DROP VIEW IF EXISTS recent_books");
  await client.query("DROP TABLE IF EXISTS books");
  await client.query("DROP TABLE IF EXISTS authors");
  await client.query(
    "CREATE TABLE books (id int PRIMARY KEY, title text, author text, year int, rating double precision)",
  );
  await client.query("CREATE TABLE authors (id int PRIMARY KEY, name text, books int)");
  for (const [id, title, author, year, rating] of BOOKS) {
    await client.query(
      "INSERT INTO books (id, title, author, year, rating) VALUES ($1, $2, $3, $4, $5)",
      [id, title, author, year, rating],
    );
  }
  for (const [id, name, books] of AUTHORS) {
    await client.query("INSERT INTO authors (id, name, books) VALUES ($1, $2, $3)", [
      id,
      name,
      books,
    ]);
  }
  await client.query("CREATE VIEW recent_books AS SELECT * FROM books WHERE year >= 2022");
  await client.query("ANALYZE books");
  await client.query("ANALYZE authors");
}

async function run(ws: Workspace, name: string, cmd: string): Promise<void> {
  const result = await ws.execute(cmd);
  const out = DEC.decode(result.stdout);
  process.stdout.write(`=== ${name} ===\n`);
  process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  if (name.startsWith("safeguard_")) {
    const err = DEC.decode(result.stderr);
    if (err) process.stdout.write(err.endsWith("\n") ? err : err + "\n");
  }
}

function setCatSafeguard(ws: Workspace, maxLines: number): void {
  const sg = new CommandSafeguard({ maxLines });
  for (const m of ws.registry.allMounts()) m.commandSafeguards.set("cat", sg);
}

async function main(): Promise<void> {
  const seedClient = new pg.Client({ connectionString: DSN });
  await seedClient.connect();
  try {
    await seed(seedClient);
  } finally {
    await seedClient.end();
  }
  const resource = new PostgresResource({ dsn: DSN, maxReadRows: 200 });
  const ws = new Workspace({ [MOUNT]: resource }, { mode: MountMode.READ });
  try {
    for (const [name, cmd] of CASES) {
      if (name === "safeguard_cat_truncates") setCatSafeguard(ws, 2);
      await run(ws, name, cmd);
    }
    await runNotFound(ws, MOUNT);
    await runProvisionProbe(ws, `${MOUNT}/public/tables/books/rows.jsonl`);
  } finally {
    await ws.close();
    await resource.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
