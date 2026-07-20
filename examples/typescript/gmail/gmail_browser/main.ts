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
import { GmailResource, MountMode, Workspace } from '@struktoai/mirage-browser'

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
  const r = await ws.execute(cmd)
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
  console.log('Loading Gmail via @struktoai/mirage-browser …')
  const resource = new GmailResource(cfg)
  const ws = new Workspace({ '/gmail': resource }, { mode: MountMode.WRITE })
  try {
    console.log(
      '=== BROWSER MODE: GmailResource → gmail.googleapis.com (CORS) ===\n',
    )

    await run(ws, 'ls /gmail/')

    console.log('')
    const dates = await run(ws, 'ls /gmail/INBOX/')
    const firstDate = dates.split('\n').filter((s) => s !== '')[0] ?? ''

    if (firstDate !== '') {
      console.log('')
      const msgs = await run(ws, `ls /gmail/INBOX/${firstDate}/`)
      const firstMsg = msgs
        .split('\n')
        .find((s) => s.endsWith('.gmail.json'))

      if (firstMsg !== undefined) {
        const msgPath = `/gmail/INBOX/${firstDate}/${firstMsg}`
        console.log('')
        await run(ws, `jq ".subject" "${msgPath}"`)
        console.log('')
        await run(ws, `jq ".from" "${msgPath}"`)
        console.log('')
        await run(ws, `wc "${msgPath}"`)
      }
    }

    console.log('')
    await run(ws, 'gws gmail +triage --query "is:unread" --max 3')

    console.log('')
    await run(ws, 'tree -L 1 /gmail/INBOX/')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
