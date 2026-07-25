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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { LanceDBResource, MountMode, Workspace } from "@struktoai/mirage-node";
import { runNotFound, runProvisionProbe, runSedReadonlyProbe } from "./cases.ts";

const MOUNT = "/db/";

const DEC = new TextDecoder();

const ROWS = [
  { id: 1, label: "cat", kind: "big", name: "a big orange cat" },
  { id: 2, label: "cat", kind: "small", name: "a small grey cat" },
  { id: 3, label: "dog", kind: "big", name: "a big brown dog" },
  { id: 4, label: "dog", kind: "small", name: "a small white dog" },
];

const CASES: [string, string][] = [
  ["ls_root", "ls {root}"],
  ["ls_table", "ls {root}animals"],
  ["ls_group", "ls {root}animals/cat"],
  ["find_md", "find {root}animals -name '*.md'"],
  ["cat_card", "cat {root}animals/cat/big/1.md"],
  ["wc_c_card", "wc -c {root}animals/cat/big/1.md"],
  // cold (bespoke) then warm (cache-mount generic) must be identical
  ["grep_cold_single", "grep orange {root}animals/cat/big/1.md"],
  ["grep_warm_single", "grep orange {root}animals/cat/big/1.md"],
  ["grep_i", "grep -i ORANGE {root}animals/cat/big/1.md"],
  ["grep_n", "grep -n label {root}animals/cat/big/1.md"],
  ["grep_v", "grep -v cat {root}animals/cat/big/1.md"],
  ["grep_c", "grep -c cat {root}animals/cat/big/1.md"],
  ["grep_o", "grep -o cat {root}animals/cat/big/1.md"],
  ["grep_w", "grep -w cat {root}animals/cat/big/1.md"],
  ["grep_F_literal", 'grep -F "id: 1" {root}animals/cat/big/1.md'],
  ["grep_m1", "grep -m 1 cat {root}animals/cat/big/1.md"],
  ["grep_A1", "grep -A 1 id {root}animals/cat/big/1.md"],
  ["grep_B1", "grep -B 1 label {root}animals/cat/big/1.md"],
  ["grep_C1", "grep -C 1 label {root}animals/cat/big/1.md"],
  [
    "grep_multi",
    "grep small {root}animals/cat/small/2.md {root}animals/dog/small/4.md",
  ],
  ["grep_r_table", "grep -r orange {root}animals"],
  ["grep_r_multipath", "grep -r small {root}animals/cat {root}animals/dog"],
  ["grep_rl", "grep -rl cat {root}animals"],
  ["grep_E_alt", 'grep -E "orange|brown" {root}animals/cat/big/1.md'],
  ["pipe_grep_stdin", "cat {root}animals/cat/big/1.md | grep orange"],
  ["rg_basic", "rg orange {root}animals/cat/big/1.md"],
  // du has no native op on lancedb -> exercises the stat/readdir walk
  // fallback, which must match the Python du builder byte for byte.
  ["du_file", "du {root}animals/cat/big/1.md"],
  ["du_group", "du {root}animals/cat"],
  ["du_table", "du {root}animals"],
  ["du_c_multi", "du -c {root}animals/cat {root}animals/dog"],
];

const EXIT_CODE_CASES: [string, string][] = [
  ["grep_q_match", "grep -q cat {root}animals/cat/big/1.md"],
  ["grep_q_no_match", "grep -q zebra {root}animals/cat/big/1.md"],
  ["grep_no_match", "grep zebra {root}animals/cat/big/1.md"],
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
}

async function main(): Promise<void> {
  const uri = mkdtempSync(join(tmpdir(), "mirage-integ-lancedb-"));
  try {
    const db = await lancedb.connect(uri);
    await db.createTable("animals", ROWS);
    const ws = new Workspace(
      {
        [MOUNT]: new LanceDBResource({
          uri,
          groupBy: ["label", "kind"],
          idColumn: "id",
          titleColumn: "name",
          textColumn: "name",
        }),
      },
      { mode: MountMode.READ },
    );
    // Vector search (the `search` command) is not exercised here: the seed
    // table ships no vector column. It is covered by unit tests
    // (src/core/lancedb tests).
    try {
      await runCases(ws);
      await runNotFound(ws, MOUNT);
      await runProvisionProbe(ws, `${MOUNT}animals/cat/big/1.md`);
      await runSedReadonlyProbe(ws, `${MOUNT}animals/cat/big/1.md`);
    } finally {
      await ws.close();
    }
  } finally {
    rmSync(uri, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
