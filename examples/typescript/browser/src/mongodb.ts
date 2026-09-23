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

import {
  HttpMongoDriver,
  MongoDBVFS,
  MountMode,
  Workspace,
} from '@struktoai/mirage-browser'

const logEl = document.getElementById('log')!

function line(text: string, cls?: string): void {
  const div = document.createElement('div')
  if (cls !== undefined) div.className = cls
  div.textContent = text
  logEl.appendChild(div)
}

async function run(ws: Workspace, cmd: string): Promise<void> {
  line(`$ ${cmd}`, 'prompt')
  const r = await ws.shell(cmd)
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') line(out)
  const err = r.stderrText.replace(/\s+$/, '')
  if (err !== '') line(err, 'err')
  if (r.exitCode !== 0) line(`exit=${String(r.exitCode)}`, 'err')
}

async function main(): Promise<void> {
  line('=== MongoDB via HTTP proxy (Vite middleware → mongodb driver in node) ===', 'ok')

  const driver = new HttpMongoDriver({ endpoint: '/api/mongo' })
  const vfs = new MongoDBVFS({
    config: { uri: 'http://proxy', defaultDocLimit: 200 },
    driver,
  })
  const ws = new Workspace({ '/mongodb/': vfs }, { mode: MountMode.READ })

  try {
    await run(ws, 'ls /mongodb')

    const dbsRes = await ws.shell('ls /mongodb')
    const dbs = dbsRes.stdoutText.split('\n').filter((s) => s.length > 0)
    if (dbs.length === 0) {
      line('no databases visible — set MONGODB_URI in .env.development', 'err')
      line('done.', 'ok')
      return
    }
    const target = dbs[0]!
    await run(ws, `ls /mongodb/${target}`)

    const colsRes = await ws.shell(`ls /mongodb/${target}`)
    const cols = colsRes.stdoutText.split('\n').filter((s) => s.endsWith('.jsonl'))
    if (cols.length === 0) {
      line(`no collections in ${target}`, 'err')
      line('done.', 'ok')
      return
    }
    const path = `/mongodb/${target}/${cols[0]!}`

    await run(ws, `head -n 1 ${path}`)
    await run(ws, `wc -l ${path}`)
    await run(ws, `jq "._id" ${path} | head -n 3`)
    await run(ws, `grep _id ${path} | head -n 2`)

    line('\ndone.', 'ok')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  line(String(err instanceof Error ? err.stack ?? err.message : err), 'err')
  line('done.', 'ok')
})
