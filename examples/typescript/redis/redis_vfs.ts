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

import { createRequire } from 'node:module'
import { MountMode, RedisResource, Workspace, patchNodeFs } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'

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
  const seedWs = new Workspace(
    { '/data': new RedisResource({ url: REDIS_URL }) },
    { mode: MountMode.WRITE },
  )
  await seedWs.execute('echo "hello world" | tee /data/hello.txt')
  await seedWs.execute('mkdir /data/sub')
  await seedWs.execute('echo "nested" | tee /data/sub/nested.txt')
  await seedWs.close()

  const ws = new Workspace(
    { '/data': new RedisResource({ url: REDIS_URL }) },
    { mode: MountMode.WRITE },
  )
  patchNodeFs(ws)

  console.log('=== VFS MODE (via require("fs")) ===\n')

  console.log('--- fs.promises.readdir("/data") ---')
  for (const e of (await fs.promises.readdir('/data')).sort()) console.log(`  ${e}`)

  console.log('\n--- fs.promises.readFile("/data/hello.txt", "utf-8") ---')
  console.log(`  ${(await fs.promises.readFile('/data/hello.txt', 'utf-8')).trim()}`)

  console.log('\n--- fs.promises.stat() / exists() ---')
  console.log(`  hello.txt: ${String(await exists('/data/hello.txt'))}`)
  console.log(`  nope.txt: ${String(await exists('/data/nope.txt'))}`)

  console.log('\n--- isDir("/data/sub") ---')
  console.log(`  /data/sub: ${String(await isDir('/data/sub'))}`)

  console.log('\n--- fs.promises.readdir("/data/sub") ---')
  for (const e of (await fs.promises.readdir('/data/sub')).sort()) console.log(`  ${e}`)

  const total = ws.records.reduce((acc, r) => acc + r.bytes, 0)
  console.log(`\nStats: ${String(ws.records.length)} ops, ${String(total)} bytes transferred`)

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
