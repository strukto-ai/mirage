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

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathSpec, ProvisionResult } from '@struktoai/mirage-core'
import {
  fileReadProvision,
  headTailProvision,
  metadataProvision,
  MountMode,
  RedisResource,
  Workspace,
} from '@struktoai/mirage-node'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const resource = new RedisResource({ url: REDIS_URL })

function print(bytes: Uint8Array): void {
  process.stdout.write(new TextDecoder().decode(bytes) + '\n')
}

async function runLabeled(ws: Workspace, label: string, cmd: string): Promise<void> {
  console.log(`=== ${label} ===`)
  const res = await ws.execute(cmd)
  print(res.stdout)
}

async function main(): Promise<void> {
  // Clear any previous state so the demo is reproducible.
  await resource.open()
  await resource.store.clear()
  await resource.store.addDir('/')

  const ws = new Workspace({ '/data': resource }, { mode: MountMode.WRITE })

  console.log('=== tee (create files) ===')
  await ws.execute('echo "hello world" | tee /data/hello.txt')
  await ws.execute(`echo '{"name": "alice", "age": 30}' | tee /data/user.json`)
  await ws.execute('mkdir /data/reports')
  await ws.execute('echo "revenue,100\\nexpense,80" | tee /data/reports/q1.csv')

  await runLabeled(ws, 'ls /data/', 'ls /data/')
  await runLabeled(ws, 'cat /data/hello.txt', 'cat /data/hello.txt')
  await runLabeled(ws, 'head -n 1 /data/reports/q1.csv', 'head -n 1 /data/reports/q1.csv')
  await runLabeled(ws, 'tail -n 1 /data/reports/q1.csv', 'tail -n 1 /data/reports/q1.csv')
  await runLabeled(ws, 'wc /data/hello.txt', 'wc /data/hello.txt')
  await runLabeled(ws, 'stat /data/hello.txt', 'stat /data/hello.txt')

  // Redis has a native setattr slot: chmod/chown/touch persist in
  // per-path attr hashes and render in ls -l.
  await ws.execute('chmod 640 /data/hello.txt')
  await ws.execute('chown 500:staff /data/hello.txt')
  await ws.execute('touch -t 202601021530 /data/hello.txt')
  await runLabeled(ws, 'METADATA (chmod / chown / touch, native)', 'ls -l /data/hello.txt')
  await runLabeled(ws, 'jq .name /data/user.json', 'jq ".name" /data/user.json')

  console.log('=== not-found errors show the full virtual path ===')
  for (const cmd of ['cat /data/missing.txt', 'head /data/missing.txt', 'stat /data/missing.txt']) {
    const res = await ws.execute(cmd)
    console.log(`$ ${cmd}`)
    console.log(`  exit=${String(res.exitCode)}  ${new TextDecoder().decode(res.stderr).trim()}`)
  }

  await runLabeled(ws, 'nl /data/reports/q1.csv', 'nl /data/reports/q1.csv')
  await runLabeled(ws, 'tree /data/', 'tree /data/')
  await runLabeled(ws, "find /data/ -name '*.txt'", `find /data/ -name '*.txt'`)
  await runLabeled(ws, 'grep hello /data/hello.txt', 'grep hello /data/hello.txt')
  await runLabeled(ws, 'rg hello /data/hello.txt', 'rg hello /data/hello.txt')
  await runLabeled(ws, 'basename /data/hello.txt', 'basename /data/hello.txt')
  await runLabeled(ws, 'dirname /data/hello.txt', 'dirname /data/hello.txt')
  await runLabeled(ws, 'realpath /data/hello.txt', 'realpath /data/hello.txt')
  await runLabeled(ws, 'sort /data/reports/q1.csv', 'sort /data/reports/q1.csv')
  await runLabeled(ws, 'tr a-z A-Z < /data/hello.txt', 'cat /data/hello.txt | tr a-z A-Z')

  console.log('=== cp /data/hello.txt /data/hello_copy.txt ===')
  await ws.execute('cp /data/hello.txt /data/hello_copy.txt')
  const cpOut = await ws.execute('cat /data/hello_copy.txt')
  print(cpOut.stdout)

  console.log('=== mv /data/hello_copy.txt /data/renamed.txt ===')
  await ws.execute('mv /data/hello_copy.txt /data/renamed.txt')
  const mvOut = await ws.execute('ls /data/')
  print(mvOut.stdout)

  console.log('=== rm /data/renamed.txt ===')
  await ws.execute('rm /data/renamed.txt')
  const rmOut = await ws.execute('ls /data/')
  print(rmOut.stdout)

  await runLabeled(ws, 'du /data/', 'du /data/')
  await runLabeled(ws, 'sed', 'cat /data/hello.txt | sed s/hello/goodbye/')
  await runLabeled(ws, 'awk', `cat /data/reports/q1.csv | awk -F, '{print $1}'`)

  console.log('=== uniq ===')
  await ws.execute('echo "a\\na\\nb\\nb\\nc" | tee /data/dup.txt')
  const uniqOut = await ws.execute('sort /data/dup.txt | uniq')
  print(uniqOut.stdout)

  await runLabeled(ws, 'rev', 'cat /data/hello.txt | rev')
  await runLabeled(ws, 'md5 /data/hello.txt', 'md5 /data/hello.txt')
  await runLabeled(ws, 'base64 /data/hello.txt', 'base64 /data/hello.txt')

  console.log('')
  console.log('=== HISTORY (/.bash_history) ===')
  console.log('  every executed command is recorded in GNU bash histfile format')
  console.log('')
  const log = await ws.execute('tail -n 5 /.bash_history')
  process.stdout.write(log.stdoutText + '\n')

  console.log('')
  console.log('=== PROVISION (cost estimates before execution) ===')
  console.log('')
  console.log('  Redis ops have no ranged GET — every read fetches the full value.')
  console.log('  Provision lets the agent budget IO / compute before running.')
  console.log('')

  // 1. Workspace-level — mirrors Python's ws.execute(cmd, provision=True)
  const wsProv = await ws.execute('cat /data/hello.txt', { provision: true })
  if (!(wsProv instanceof ProvisionResult)) throw new Error('expected ProvisionResult')
  console.log(`  ws.execute('cat /data/hello.txt', { provision: true }):`)
  console.log(`    command        = ${wsProv.command ?? '(none)'}`)
  console.log(`    networkRead    = ${wsProv.networkRead}`)
  console.log(`    readOps        = ${String(wsProv.readOps)}`)
  console.log(`    precision      = ${wsProv.precision}`)
  console.log('')

  // 2. Redis-specific helpers — use these when you want exact cost for Redis.
  const paths = [
    PathSpec.fromStrPath('/data/hello.txt', 'hello.txt'),
    PathSpec.fromStrPath('/data/user.json', 'user.json'),
  ]

  const readCost = await fileReadProvision(resource.accessor, paths, { command: 'cat' })
  console.log(`  fileReadProvision(resource.accessor, [hello.txt, user.json]):`)
  console.log(`    networkRead    = ${readCost.networkRead} bytes (${String(readCost.readOps)} reads)`)
  console.log(`    precision      = ${readCost.precision}`)

  const headCost = await headTailProvision(resource.accessor, paths, { command: 'head -n 1' })
  console.log(`  headTailProvision(...) — Redis fetches full value regardless of -n:`)
  console.log(`    networkRead    = ${headCost.networkRead} bytes`)

  const metaCost = metadataProvision(resource.accessor, paths, { command: 'stat' })
  console.log(`  metadataProvision(...) — stat/ls/find cost zero network bytes:`)
  console.log(`    networkRead    = ${metaCost.networkRead} bytes`)
  console.log(`    readOps        = ${String(metaCost.readOps)}`)

  console.log('')
  console.log('=== PERSISTENCE ===')
  console.log('')
  console.log('  Redis is a remote store — snapshot dumps the full key+value set.')
  console.log('  `copy()` shares the same Redis instance (no independent state).')
  console.log('')
  const tmpDir = mkdtempSync(join(tmpdir(), 'mirage-redis-snap-'))
  const snapPath = join(tmpDir, 'snap.json')
  try {
    await ws.snapshot(snapPath)
    const size = statSync(snapPath).size
    console.log(`  saved → ${snapPath} (${String(size)} bytes)`)

    // ws.copy() — mirrors Python: remote resources (needsOverride=true) are reused,
    // local ones are reconstructed. Both copies see the same Redis state.
    const cp = await ws.copy()
    console.log(`  copy() mounts: [${cp.mounts().map((m) => m.prefix).join(', ')}]`)
    const cpCat = await cp.execute('cat /data/hello.txt')
    console.log(`  copy() sees original's writes: ${cpCat.stdoutText.trim()}`)
    await cp.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log('')
  console.log('=== CLEANUP ===')
  await resource.store.clear()
  await ws.close()
  console.log('  wiped test keys from Redis')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
