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

import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantResource, MountMode, Workspace } from "@struktoai/mirage-node";

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_HOST = process.env.QDRANT_HOST ?? "localhost";
const QDRANT_PORT = Number(process.env.QDRANT_PORT ?? "6333");
const EMBED_DIM = 8;
const COLLECTION = "mirage_integ";
const MOUNT = "/db/";

const DEC = new TextDecoder();

const ROWS: [number, string, string, string][] = [
  [1, "cat", "big", "a big orange cat"],
  [2, "cat", "small", "a small grey cat"],
  [3, "dog", "big", "a big brown dog"],
  [4, "dog", "small", "a small white dog"],
];

const CASES: [string, string][] = [
  ["ls_root", "ls {root}"],
  ["ls_group", "ls {root}cat"],
  ["ls_leaf", "ls {root}cat/big"],
  ["tree", "tree {root}"],
  ["find_txt", "find {root} -name '*.txt'"],
  ["find_json", "find {root} -name '*.json'"],
  ["cat_txt", "cat {root}cat/big/1.txt"],
  ["cat_json", "cat {root}cat/big/1.json"],
  ["wc_c_txt", "wc -c {root}cat/big/1.txt"],
  ["grep_text", "grep orange {root}cat/big/1.txt"],
  ["grep_json_field", "grep label {root}cat/big/1.json"],
  ["grep_i", "grep -i ORANGE {root}cat/big/1.txt"],
  ["grep_n", "grep -n cat {root}cat/big/1.json"],
  ["grep_c", "grep -c cat {root}cat/big/1.json"],
  ["grep_o", "grep -o cat {root}cat/big/1.json"],
  ["grep_w", "grep -w big {root}cat/big/1.json"],
  ["grep_F_literal", "grep -F 'orange cat' {root}cat/big/1.txt"],
  ["grep_E_alt", 'grep -E "orange|brown" {root}cat/big/1.txt'],
  ["grep_v", "grep -v zebra {root}cat/big/1.txt"],
  ["grep_multi", "grep small {root}cat/small/2.json {root}dog/small/4.json"],
  ["grep_r_group", "grep -r orange {root}cat"],
  ["grep_rl", "grep -rl cat {root}"],
  ["pipe_grep_stdin", "cat {root}cat/big/1.json | grep orange"],
  ["rg_basic", "rg orange {root}cat/big/1.txt"],
  // du has no native op -> exercises the stat/readdir walk fallback,
  // which must match the Python du builder byte for byte.
  ["du_leaf", "du {root}cat/big"],
  ["du_group", "du {root}cat"],
  ["du_root", "du {root}"],
  ["du_c_multi", "du -c {root}cat {root}dog"],
  // symlink into the mount (namespace state; works on a read-only backend)
  ["sym_ln", "ln -s {root}cat/big/1.json {root}meta_link"],
  ["sym_readlink", "readlink {root}meta_link"],
  ["sym_cat", "cat {root}meta_link"],
  ["sym_grep", "grep label {root}meta_link"],
  ["sym_ls", "ls -F {root} | grep meta_link"],
  ["sym_rm", "rm {root}meta_link && ls {root}"],
];

const EXIT_CODE_CASES: [string, string][] = [
  ["grep_q_match", "grep -q cat {root}cat/big/1.txt"],
  ["grep_q_no_match", "grep -q zebra {root}cat/big/1.txt"],
  ["grep_no_match", "grep zebra {root}cat/big/1.txt"],
];

const NOT_FOUND_PROGS: [string, string][] = [
  ["nf_cat", "cat"],
  ["nf_head", "head"],
  ["nf_tail", "tail"],
  ["nf_wc", "wc"],
  ["nf_stat", "stat"],
  ["nf_grep", "grep x"],
];

async function runCases(ws: Workspace): Promise<void> {
  for (const [name, tmpl] of CASES) {
    const result = await ws.execute(tmpl.replaceAll("{root}", MOUNT));
    const out = DEC.decode(result.stdout);
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  }
  for (const [name, tmpl] of EXIT_CODE_CASES) {
    const result = await ws.execute(tmpl.replaceAll("{root}", MOUNT));
    const out = DEC.decode(result.stdout);
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`exit=${result.exitCode}\n`);
    if (out) process.stdout.write(out.endsWith("\n") ? out : out + "\n");
  }
  const target = `${MOUNT.replace(/\/+$/, "")}/cat/big/__nf_missing__.json`;
  for (const [name, prog] of NOT_FOUND_PROGS) {
    const result = await ws.execute(`${prog} ${target}`);
    const err = DEC.decode(result.stderr).trim();
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`exit=${result.exitCode}\n`);
    if (err) process.stdout.write(err + "\n");
  }
  const provTarget = `${MOUNT}cat/big/1.txt`;
  const provProbes: ReadonlyArray<readonly [string, string]> = [
    ["prov_probe_cat", `cat ${provTarget}`],
    ["prov_probe_grep", `grep x ${provTarget}`],
    ["prov_probe_ls", `ls ${MOUNT}cat/big`],
  ];
  for (const [name, cmd] of provProbes) {
    const result = await ws.execute(cmd, { provision: true });
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(
      `net=${result.networkRead} write=${result.networkWrite} ` +
        `cache=${result.cacheRead} ops=${String(result.readOps)} ` +
        `hits=${String(result.cacheHits)} precision=${result.precision}\n`,
    );
  }

  let result = await ws.execute(`sed -n 1p ${provTarget}`);
  const out = new TextDecoder().decode(result.stdout);
  process.stdout.write(`=== sed_stream_1p ===\n`);
  process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  result = await ws.execute(`sed -i s/x/y/ ${provTarget}`);
  const err = new TextDecoder().decode(result.stderr).trim();
  process.stdout.write(`=== sed_i_readonly ===\n`);
  process.stdout.write(`exit=${String(result.exitCode)}\n`);
  if (err) process.stdout.write(`${err}\n`);
}

function client(): QdrantClient {
  if (QDRANT_URL !== undefined && QDRANT_URL !== "") {
    return new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });
  }
  return new QdrantClient({ host: QDRANT_HOST, port: QDRANT_PORT });
}

async function seed(c: QdrantClient): Promise<void> {
  await c.deleteCollection(COLLECTION).catch(() => {});
  await c.createCollection(COLLECTION, {
    vectors: { size: EMBED_DIM, distance: "Cosine" },
  });
  await c.upsert(COLLECTION, {
    points: ROWS.map(([id, label, kind, name]) => ({
      id,
      vector: Array(EMBED_DIM).fill(0.1),
      payload: { label, kind, name },
    })),
  });
  for (const field of ["label", "kind"]) {
    await c.createPayloadIndex(COLLECTION, {
      field_name: field,
      field_schema: "keyword",
    });
  }
  await new Promise((r) => setTimeout(r, 2000));
}

async function main(): Promise<void> {
  const c = client();
  try {
    await seed(c);
    const ws = new Workspace(
      {
        [MOUNT]: new QdrantResource({
          url: QDRANT_URL,
          apiKey: QDRANT_API_KEY,
          host: QDRANT_HOST,
          port: QDRANT_PORT,
          collection: COLLECTION,
          groupBy: ["label", "kind"],
          idField: "id",
          textField: "name",
        }),
      },
      { mode: MountMode.READ },
    );
    try {
      await runCases(ws);
    } finally {
      await ws.close();
    }
  } finally {
    await c.deleteCollection(COLLECTION).catch(() => {});
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
