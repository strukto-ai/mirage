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

import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskResource, MountMode, Workspace, patchNodeFs } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const REPO_ROOT = new URL('../../..', import.meta.url).pathname
const DATA_DIR = join(REPO_ROOT, 'data')

const tmp = mkdtempSync(join(tmpdir(), 'mirage-disk-'))
const filesDir = join(tmp, 'files')
cpSync(DATA_DIR, filesDir, { recursive: true })

async function run(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n$ ${cmd}`)
  const r = await ws.execute(cmd)
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') console.log(out)
  const err = r.stderrText.replace(/\s+$/, '')
  if (err !== '') console.error('stderr:', err)
  if (r.exitCode !== 0) console.error(`exit=${String(r.exitCode)}`)
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/data': new DiskResource({ root: filesDir }) },
    { mode: MountMode.WRITE },
  )
  patchNodeFs(ws)

  console.log(`mounted /data/ → ${filesDir}`)

  await run(ws, 'ls /data/')
  await run(ws, 'head -n 3 /data/example.jsonl')
  await run(ws, 'wc /data/example.json')
  await run(ws, 'stat /data/example.json')
  await run(ws, 'tree /data/')
  await run(ws, "find /data/ -name '*.json'")
  await run(ws, 'du /data/')
  await run(ws, 'jq .company /data/example.json')
  await run(ws, 'basename /data/example.json')
  await run(ws, 'dirname /data/example.json')

  console.log('\n━━━ filetype dispatch (parquet via DISK + read op) ━━━')
  await run(ws, 'head -n 3 /data/example.parquet')
  console.log('\n--- fs.promises.readFile (read op with .parquet filetype) ---')
  try {
    const text = await fs.promises.readFile('/data/example.parquet', 'utf-8')
    console.log(text.slice(0, 200))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
  }

  console.log('\n━━━ write-through ━━━')
  await run(ws, "echo 'hello from disk' | tee /data/mirage_hello.txt")
  await run(ws, 'cat /data/mirage_hello.txt')

  console.log('\n━━━ metadata (chmod / chown / touch) ━━━')
  console.log('(mode hits the real inode AND a sidecar, so ls -l is umask-independent;')
  console.log(' uid/gid are sidecar-only; times hit the real inode)')
  await run(ws, 'chmod 640 /data/mirage_hello.txt')
  await run(ws, 'chown 500:staff /data/mirage_hello.txt')
  await run(ws, 'touch -t 202601021530 /data/mirage_hello.txt')
  await run(ws, 'ls -l /data/mirage_hello.txt')
  const real = statSync(join(filesDir, 'mirage_hello.txt'))
  console.log(`real inode mode: ${(real.mode & 0o777).toString(8)}, mtime: ${real.mtime.toISOString()}`)

  console.log('\n━━━ fs-monkey routes /data/ through workspace ━━━')
  console.log('(ESM `import from "node:fs"` is NOT patchable — only CJS `require("fs")`)')
  const text = await fs.promises.readFile('/data/mirage_hello.txt', 'utf-8')
  console.log('require("fs").promises.readFile:', text.trimEnd())
  const entries = await fs.promises.readdir('/data/')
  console.log('require("fs").promises.readdir:', entries.slice(0, 3).join(', '), '...')

  console.log('\n━━━ not-found errors show the full virtual path ━━━')
  for (const cmd of ['cat /data/missing.json', 'head /data/missing.json', 'stat /data/missing.json']) {
    const res = await ws.execute(cmd)
    console.log(`$ ${cmd}\n  exit=${String(res.exitCode)}  ${new TextDecoder().decode(res.stderr).trim()}`)
  }

  await ws.close()
  rmSync(tmp, { recursive: true, force: true })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
