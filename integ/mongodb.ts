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

import { Double, MongoClient } from "mongodb";
import {
  CommandSafeguard,
  MongoDBResource,
  MountMode,
  Workspace,
} from "@struktoai/mirage-node";
import { runNotFound } from "./cases.ts";

const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const DB = "mirage_integ";
const MOUNT = "/mongodb";

const DEC = new TextDecoder();

const BOOKS = [
  { _id: 1, title: "alpha", author: "ada", year: 2020, tags: ["fiction", "classic"], rating: 4.5 },
  { _id: 2, title: "beta", author: "ben", year: 2021, tags: ["fiction"], rating: 3.2 },
  { _id: 3, title: "gamma", author: "cara", year: 2022, rating: 5.0 },
  { _id: 4, title: "delta", author: "ada", year: 2023, tags: ["history"], rating: 4.0 },
  { _id: 5, title: "epsilon", author: "ben", year: 2024, rating: 2.5 },
];

const AUTHORS = [
  { _id: 1, name: "ada", books: 2 },
  { _id: 2, name: "ben", books: 2 },
  { _id: 3, name: "cara", books: 1 },
];

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["ls_root", `ls ${MOUNT}/`],
  ["ls_db", `ls ${MOUNT}/${DB}/`],
  ["ls_collections", `ls ${MOUNT}/${DB}/collections/`],
  ["ls_views", `ls ${MOUNT}/${DB}/views/`],
  ["ls_entity", `ls ${MOUNT}/${DB}/collections/books/`],
  ["tree", `tree -L 3 ${MOUNT}/${DB}/`],
  ["cat_database_json", `cat ${MOUNT}/${DB}/database.json`],
  ["cat_schema_json", `cat ${MOUNT}/${DB}/collections/books/schema.json`],
  ["cat_docs", `cat ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["head_2", `head -n 2 ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["tail_2", `tail -n 2 ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["wc_l_books", `wc -l ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["wc_default_books", `wc ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["wc_l_authors", `wc -l ${MOUNT}/${DB}/collections/authors/documents.jsonl`],
  ["stat_docs", `stat ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["grep_c_title", `grep -c title ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["grep_ada", `grep ada ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["grep_e_multi", `grep -n -e ada -e ben ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["grep_r_e_multi", `grep -r -e alpha -e beta ${MOUNT}/${DB}/collections/books`],
  ["grep_db_scope", `grep ada ${MOUNT}/${DB}/`],
  ["grep_root_scope", `grep ada ${MOUNT}/`],
  ["rg_db_scope", `rg ben ${MOUNT}/${DB}/`],
  ["rg_e_multi", `rg -e gamma -e cara ${MOUNT}/${DB}/collections/books`],
  ["find_docs", `find ${MOUNT}/${DB}/ -name documents.jsonl`],
  ["find_schema", `find ${MOUNT}/${DB}/ -name schema.json`],
  ["jq_titles", `jq '.title' ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["pipe_grep_c", `cat ${MOUNT}/${DB}/collections/books/documents.jsonl | grep -c fiction`],
  ["cat_view_docs", `cat ${MOUNT}/${DB}/views/recent_books/documents.jsonl`],
  ["wc_l_view", `wc -l ${MOUNT}/${DB}/views/recent_books/documents.jsonl`],
  ["safeguard_cat_truncates", `cat ${MOUNT}/${DB}/collections/books/documents.jsonl`],
  ["safeguard_cat_pipe_uncapped", `cat ${MOUNT}/${DB}/collections/books/documents.jsonl | wc -l`],
];

async function seed(client: MongoClient): Promise<void> {
  const db = client.db(DB);
  await db.dropDatabase();
  // Python seeds floats (BSON double); insert Double so the inferred schema
  // matches (JS whole numbers would otherwise serialize to BSON int32).
  await db
    .collection("books")
    .insertMany(BOOKS.map((d) => ({ ...d, rating: new Double(d.rating) })));
  await db.collection("authors").insertMany(AUTHORS.map((d) => ({ ...d })));
  await db.createCollection("recent_books", {
    viewOn: "books",
    pipeline: [{ $match: { year: { $gte: 2022 } } }],
  });
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

async function insertUntilDone(
  client: MongoClient,
  done: () => boolean,
): Promise<void> {
  let i = 0;
  while (!done()) {
    i += 1;
    await client
      .db(DB)
      .collection("books")
      .insertOne({ _id: 100 + i, title: "live_insert" });
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function runFollow(ws: Workspace, client: MongoClient): Promise<void> {
  const name = "tail_f_change_stream";
  const cmd = `tail -f ${MOUNT}/${DB}/collections/books/documents.jsonl | head -n 1`;
  let finished = false;
  const followP = ws.execute(cmd).then((result) => {
    finished = true;
    return DEC.decode(result.stdout);
  });
  const inserter = insertUntilDone(client, () => finished);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("tail -f change stream timed out")), 30000),
  );
  try {
    const out = await Promise.race([followP, timeout]);
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  } finally {
    finished = true;
    await inserter;
  }
}

function setCatSafeguard(ws: Workspace, maxLines: number): void {
  const sg = new CommandSafeguard({ maxLines });
  for (const m of ws.registry.allMounts()) m.commandSafeguards.set("cat", sg);
}

async function main(): Promise<void> {
  const seedClient = new MongoClient(MONGODB_URI);
  await seedClient.connect();
  try {
    await seed(seedClient);
  } finally {
    await seedClient.close();
  }
  const resource = new MongoDBResource({ uri: MONGODB_URI, databases: [DB] });
  const ws = new Workspace({ [MOUNT]: resource }, { mode: MountMode.READ });
  try {
    for (const [name, cmd] of CASES) {
      if (name === "safeguard_cat_truncates") setCatSafeguard(ws, 2);
      await run(ws, name, cmd);
    }
    await runNotFound(ws, MOUNT);
    const liveClient = new MongoClient(MONGODB_URI);
    await liveClient.connect();
    try {
      await runFollow(ws, liveClient);
    } finally {
      await liveClient.close();
    }
  } finally {
    await ws.close();
    await resource.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
