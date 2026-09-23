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
import { GDriveVFS, MountMode, Workspace } from '@struktoai/mirage-browser'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function buildConfig(): { clientId: string; clientSecret: string; refreshToken: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

async function run(ws: Workspace, cmd: string): Promise<string> {
  console.log(`$ ${cmd}`)
  const r = await ws.shell(cmd)
  if (r.exitCode !== 0 && r.stderrText !== '') {
    console.log(`  STDERR: ${r.stderrText.slice(0, 200)}`)
  }
  const out = r.stdoutText.replace(/\s+$/, '')
  if (out !== '') {
    for (const line of out.split('\n').slice(0, 12)) console.log(`  ${line.slice(0, 200)}`)
  }
  return out
}

async function main(): Promise<void> {
  const cfg = buildConfig()
  console.log('Loading Google Drive via @struktoai/mirage-browser …')
  const vfs = new GDriveVFS(cfg)
  const ws = new Workspace({ '/gdrive': vfs }, { mode: MountMode.WRITE })
  try {
    console.log(
      '=== BROWSER MODE: GDriveVFS → drive/docs/sheets/slides googleapis.com (CORS) ===\n',
    )

    await run(ws, 'ls /gdrive/')

    console.log('')
    await run(ws, 'tree -L 2 /gdrive/')

    console.log('')
    await run(ws, "find /gdrive/ -name '*.gdoc.json' | head -n 3")

    console.log('')
    await run(ws, "find /gdrive/ -name '*.gsheet.json' | head -n 3")

    console.log('')
    const docFinds = await run(ws, "find /gdrive/ -name '*.gdoc.json' | head -n 1")
    const firstDoc = docFinds.split('\n')[0]
    if (firstDoc !== undefined && firstDoc !== '') {
      console.log('')
      await run(ws, `jq ".title" "${firstDoc}"`)
      console.log('')
      await run(ws, `wc "${firstDoc}"`)
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
