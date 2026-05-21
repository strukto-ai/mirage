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

import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskResource, MountMode, Workspace, patchNodeFs } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const REPO_ROOT = new URL('../../..', import.meta.url).pathname
const DATA_DIR = join(REPO_ROOT, 'data')

const tmp = mkdtempSync(join(tmpdir(), 'mirage-disk-vfs-'))
const filesDir = join(tmp, 'files')
cpSync(DATA_DIR, filesDir, { recursive: true })

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p)
    return true
  } catch {
    return false
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/data': new DiskResource({ root: filesDir }) },
    { mode: MountMode.READ },
  )
  patchNodeFs(ws)

  console.log('=== VFS MODE (via require("fs")) ===\n')

  console.log('--- fs.promises.readdir("/data") ---')
  for (const e of (await fs.promises.readdir('/data')).sort()) console.log(`  ${e}`)

  console.log('\n--- fs.promises.readFile("/data/example.json", "utf-8") ---')
  const json = await fs.promises.readFile('/data/example.json', 'utf-8')
  console.log(json.trim())

  console.log('\n--- fs.promises.stat() / exists() ---')
  console.log(`  example.json: ${String(await exists('/data/example.json'))}`)
  console.log(`  nope.txt: ${String(await exists('/data/nope.txt'))}`)

  console.log('\n--- isDir("/data") ---')
  console.log(`  /data: ${String(await isDir('/data'))}`)

  const total = ws.records.reduce((acc, r) => acc + r.bytes, 0)
  console.log(`\nStats: ${String(ws.records.length)} ops, ${String(total)} bytes transferred`)

  await ws.close()
  rmSync(tmp, { recursive: true, force: true })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
