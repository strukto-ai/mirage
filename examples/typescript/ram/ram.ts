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
import { MountMode, RAMResource, Workspace } from '@struktoai/mirage-node'

const resource = new RAMResource()

function print(bytes: Uint8Array): void {
  process.stdout.write(new TextDecoder().decode(bytes) + '\n')
}

async function runLabeled(ws: Workspace, label: string, cmd: string): Promise<void> {
  console.log(`=== ${label} ===`)
  const res = await ws.execute(cmd)
  print(res.stdout)
}

async function main(): Promise<void> {
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
  await runLabeled(ws, 'jq .name /data/user.json', 'jq ".name" /data/user.json')
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

  await runLabeled(ws, 'history (last 5)', 'history 5')

  console.log('')
  console.log('=== not-found errors show the full virtual path ===')
  for (const cmd of ['cat /data/missing.txt', 'head /data/missing.txt', 'stat /data/missing.txt']) {
    const res = await ws.execute(cmd)
    console.log(`$ ${cmd}`)
    console.log(`  exit=${String(res.exitCode)}  ${new TextDecoder().decode(res.stderr).trim()}`)
  }

  console.log('')
  console.log('=== GLOB EXPANSION ===')
  console.log('')
  await ws.execute('echo "AA" | tee /data/a.txt')
  await ws.execute('echo "BB" | tee /data/b.txt')
  await ws.execute('echo "CC" | tee /data/c.md')
  await runLabeled(ws, 'cat /data/*.txt', 'cat /data/*.txt')
  await runLabeled(ws, 'ls /data/*.txt', 'ls /data/*.txt')
  await runLabeled(ws, 'grep . /data/*.txt', 'grep . /data/*.txt')
  await runLabeled(ws, 'wc -l /data/*.md', 'wc -l /data/*.md')

  console.log('')
  console.log('=== /dev (auto-mounted synthetic devices) ===')
  console.log('')
  await runLabeled(ws, 'ls /dev/', 'ls /dev/')
  await runLabeled(ws, 'wc -c /dev/null', 'wc -c /dev/null')
  await runLabeled(ws, 'wc -c /dev/zero', 'wc -c /dev/zero')
  await runLabeled(ws, 'md5 /dev/zero', 'md5 /dev/zero')
  await runLabeled(ws, 'head -c 8 /dev/zero | xxd', 'head -c 8 /dev/zero | xxd')

  console.log('')
  console.log('=== HISTORY (/.bash_history) ===')
  console.log('  every executed command is recorded in GNU bash histfile format')
  console.log('')
  const log = await ws.execute('tail -n 5 /.bash_history')
  process.stdout.write(log.stdoutText + '\n')

  console.log('')
  console.log('=== PROVISION (dry-run cost estimates) ===')
  console.log('')
  // Read families estimate bytes from stat; pipes/&&/; sum, || takes a
  // min-max envelope, and writes report UNKNOWN.
  for (const cmd of [
    'cat /data/hello.txt',
    'sort /data/hello.txt | head -n 1',
    'head /data/hello.txt || cat /data/hello.txt',
    'tee /data/out.txt',
  ]) {
    const plan = await ws.execute(cmd, { provision: true })
    console.log(
      `  ${cmd}: net=${plan.networkRead} ops=${String(plan.readOps)} ` +
        `precision=${plan.precision}`,
    )
  }

  console.log('')
  console.log('=== PERSISTENCE ===')
  console.log('')
  const tmpDir = mkdtempSync(join(tmpdir(), 'mirage-snap-'))
  const snapPath = join(tmpDir, 'snap.json')
  const repr = (s: string): string => `'${s}'`
  try {
    await ws.snapshot(snapPath)
    const size = statSync(snapPath).size
    console.log(`  saved → ${snapPath} (${String(size)} bytes)`)

    const loaded = await Workspace.load(snapPath, { mode: MountMode.WRITE })
    const r = await loaded.execute('cat /data/hello.txt')
    console.log(`  loaded ws cat: ${repr(r.stdoutText.trim())}`)

    const cp = await ws.copy()
    await cp.execute('echo "mutated" | tee /data/hello.txt')
    const rOrig = await ws.execute('cat /data/hello.txt')
    const rCp = await cp.execute('cat /data/hello.txt')
    console.log(`  original:  ${repr(rOrig.stdoutText.trim())}`)
    console.log(`  copy:      ${repr(rCp.stdoutText.trim())}  (local backend → independent)`)

    await loaded.close()
    await cp.close()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
