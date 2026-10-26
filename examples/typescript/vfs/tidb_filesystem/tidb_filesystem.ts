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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  MountMode,
  TiDBFilesystemVFS,
  Workspace,
  normalizeTiDBFilesystemConfig,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

async function run(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n>>> ${cmd}`)
  const result = await ws.shell(cmd)
  const stdout = result.stdoutText.trim()
  const stderr = result.stderrText.trim()
  if (stdout !== '') {
    for (const line of stdout.split('\n').slice(0, 12)) console.log(`  ${line.slice(0, 140)}`)
  }
  if (stderr !== '') console.log(`  [stderr] ${stderr.slice(0, 140)}`)
  if (stdout === '' && stderr === '') console.log(`  (empty, exit=${String(result.exitCode)})`)
}

async function main(): Promise<void> {
  const vfs = await TiDBFilesystemVFS.create(
    normalizeTiDBFilesystemConfig({
      host: process.env.TIDB_FILESYSTEM_HOST,
      token: process.env.TIDB_FILESYSTEM_TOKEN,
      root_path: process.env.TIDB_FILESYSTEM_ROOT_PATH ?? '/',
    }),
  )
  const ws = new Workspace({ '/fs': vfs }, { mode: MountMode.WRITE })
  try {
    await run(ws, 'mkdir -p /fs/mirage-example/notes')
    await run(ws, "echo 'hello from mirage' > /fs/mirage-example/notes/a.txt")
    await run(ws, 'seq 1 20000 > /fs/mirage-example/numbers.txt')
    await run(ws, 'ls -l /fs/mirage-example /fs/mirage-example/notes')
    await run(ws, 'cat /fs/mirage-example/notes/a.txt')
    await run(ws, 'tail -n 2 /fs/mirage-example/numbers.txt')
    await run(ws, 'grep -c 9 /fs/mirage-example/numbers.txt')
    await run(ws, 'mv /fs/mirage-example/notes /fs/mirage-example/moved')
    await run(ws, 'find /fs/mirage-example | sort')
    await run(ws, 'cat /fs/mirage-example/nope.txt')
    await run(ws, 'rm -r /fs/mirage-example')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
