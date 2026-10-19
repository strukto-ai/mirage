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
import { MountMode, RAMVFS, Workspace, patchNodeFs } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

async function run(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n$ ${cmd}`)
  try {
    const r = await ws.shell(cmd)
    const out = r.stdoutText.replace(/\s+$/, '')
    if (out !== '') console.log(out)
    const err = r.stderrText.replace(/\s+$/, '')
    if (err !== '') console.error('stderr:', err)
    if (r.exitCode !== 0) console.error(`exit=${String(r.exitCode)}`)
  } catch (err) {
    console.error('threw:', err instanceof Error ? err.message : String(err))
  }
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  patchNodeFs(ws)

  await fs.promises.writeFile('/data/dup.txt', 'banana\napple\ncherry\napple\n')
  await fs.promises.writeFile('/data/sorted1.txt', 'apple\nbanana\ndate\n')
  await fs.promises.writeFile('/data/sorted2.txt', 'banana\ncherry\ndate\n')
  await fs.promises.writeFile('/data/tsv.txt', 'a\tb\tc\nfoo\t42\tbar\nhello\t7\tworld\n')
  await fs.promises.writeFile('/data/csv.txt', '1,alpha,x\n2,beta,y\n3,gamma,z\n')
  await fs.promises.writeFile('/data/tabs.txt', '\tfoo\n\t\tbar\n')
  await fs.promises.writeFile(
    '/data/prose.txt',
    'The quick brown fox jumps over the lazy dog. ' +
      'The quick brown fox jumps over the lazy dog. ' +
      'The quick brown fox jumps over the lazy dog.\n',
  )
  await fs.promises.writeFile('/data/words.txt', 'apple\nant\nbanana\nberry\ncherry\n')
  await fs.promises.writeFile('/data/join_a.txt', '1 alpha\n2 beta\n3 gamma\n')
  await fs.promises.writeFile('/data/join_b.txt', '1 red\n2 green\n3 blue\n')
  await fs.promises.writeFile('/data/deps.txt', 'a b\nb c\nc d\n')
  await fs.promises.writeFile(
    '/data/binary.bin',
    Buffer.from([
      0x00, 0x01, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x02, 0x77, 0x6f, 0x72,
      0x6c, 0x64, 0x00, 0xff,
    ]),
  )

  console.log('━━━ column ━━━')
  await run(ws, 'column -t /data/tsv.txt')

  console.log('\n━━━ comm (sorted1 vs sorted2) ━━━')
  await run(ws, 'comm /data/sorted1.txt /data/sorted2.txt')

  console.log('\n━━━ expand / unexpand ━━━')
  await run(ws, 'expand -t 4 /data/tabs.txt')
  await run(ws, 'unexpand -t 4 /data/tsv.txt')

  console.log('\n━━━ fmt / fold ━━━')
  await run(ws, 'fmt -w 40 /data/prose.txt')
  await run(ws, 'fold -w 20 -s /data/prose.txt')

  console.log('\n━━━ iconv ━━━')
  await run(ws, 'iconv -f utf-8 -t latin1 /data/sorted1.txt')

  console.log('\n━━━ join ━━━')
  await run(ws, 'join /data/join_a.txt /data/join_b.txt')

  console.log('\n━━━ look ━━━')
  await run(ws, 'look ban /data/words.txt')
  await run(ws, 'look app /data/words.txt')

  console.log('\n━━━ mktemp ━━━')
  await run(ws, 'mktemp -p /data')

  console.log('\n━━━ shuf / strings ━━━')
  await run(ws, 'shuf /data/dup.txt')
  await run(ws, 'strings -n 4 /data/binary.bin')

  console.log('\n━━━ tsort ━━━')
  await run(ws, 'tsort /data/deps.txt')

  console.log('\n━━━ csplit (split on pattern) ━━━')
  await run(ws, "csplit /data/tsv.txt '/hello/'")
  await run(ws, 'ls /data/')

  console.log('\n━━━ zip + unzip (roundtrip) ━━━')
  await run(ws, 'zip /data/out.zip /data/sorted1.txt /data/sorted2.txt')
  await run(ws, 'unzip -d /data/extracted /data/out.zip')
  await run(ws, 'ls /data/extracted/')
  await run(ws, 'ls /data/extracted/data/')
  await run(ws, 'cat /data/extracted/data/sorted1.txt')

  console.log('\n━━━ zgrep (gzip then search) ━━━')
  await run(ws, 'gzip /data/words.txt')
  await run(ws, 'zgrep banana /data/words.txt.gz')

  console.log('\n━━━ patch (unified diff) ━━━')
  await fs.promises.writeFile('/data/orig.txt', 'line1\nline2\nline3\n')
  await fs.promises.writeFile(
    '/data/change.diff',
    `--- /orig.txt\n+++ /orig.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3\n`,
  )
  await run(ws, 'patch -i /data/change.diff')
  await run(ws, 'cat /data/orig.txt')

  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
