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

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  Workspace,
  configToWorkspaceArgs,
  loadWorkspaceConfigFile,
} from '@struktoai/mirage-node'

// workspace.yaml loads SqliteRuntime from sqlite_runtime.mjs beside it. The
// agent only ever types sqlite3; the yaml decides where that runs. Needs the
// sqlite3 command-line tool on PATH.

const CONFIG = new URL('./workspace.yaml', import.meta.url).pathname

const LINES: [string, string][] = [
  ["sqlite3 /data/shop.db 'select count(*) from orders'", 'a query'],
  [
    "sqlite3 -json /data/shop.db 'select * from orders' | jq -r '.[].item'",
    'its output pipes into workspace commands',
  ],
  ["echo 'select sum(total) from orders;' | sqlite3 /data/shop.db", 'SQL on stdin'],
  [
    `cd /data && sqlite3 shop.db "insert into orders values (4, 'lamp', 30)"`,
    'a write, relative to the cwd, lands back in the mount',
  ],
  ["sqlite3 /data/shop.db 'select count(*) from orders'", 'and stays'],
  [
    `sqlite3 /archive/2025.db "insert into orders values (9, 'x', 1)"`,
    'a read-only mount refuses the write-back',
  ],
  ["sqlite3 /archive/2025.db 'select count(*) from orders'", 'unchanged'],
]

const SEED = `create table orders (id int, item text, total int);
insert into orders values (1, 'desk', 120), (2, 'chair', 80), (3, 'shelf', 45);`

/** A small orders database, as bytes to seed the mounts with. */
function database(dir: string, name: string): Uint8Array {
  const path = join(dir, name)
  execFileSync('sqlite3', [path], { input: SEED })
  return new Uint8Array(readFileSync(path))
}

const dec = new TextDecoder()

async function main(): Promise<void> {
  const archive = mkdtempSync(join(tmpdir(), 'archive-'))
  try {
    database(archive, '2025.db')
    process.env.ARCHIVE_DIR = archive
    const args = await configToWorkspaceArgs(loadWorkspaceConfigFile(CONFIG))
    const ws = new Workspace(args.mounts, args.options)
    try {
      const seed = mkdtempSync(join(tmpdir(), 'seed-'))
      await ws.vfs.write('/data/shop.db', database(seed, 'shop.db'))
      rmSync(seed, { recursive: true, force: true })
      for (const [line, note] of LINES) {
        const res = await ws.shell(line)
        console.log(`$ ${line}    # ${note}`)
        process.stdout.write(res.stdout === null ? '' : dec.decode(res.stdout))
        process.stdout.write(res.stderr === null ? '' : dec.decode(res.stderr))
        console.log(`[exit ${res.exitCode}]\n`)
      }
    } finally {
      await ws.close()
    }
  } finally {
    rmSync(archive, { recursive: true, force: true })
  }
}

await main()
