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
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { BoxVFS, MountMode, patchNodeFs, Workspace, type BoxConfig } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): BoxConfig {
  const devToken = process.env.BOX_DEVELOPER_TOKEN ?? process.env.BOX_ACCESS_TOKEN ?? ''
  if (devToken !== '') {
    return { accessToken: devToken }
  }
  const clientId = process.env.BOX_CLIENT_ID ?? ''
  const clientSecret = process.env.BOX_CLIENT_SECRET ?? ''
  const enterpriseId = process.env.BOX_ENTERPRISE_ID ?? ''
  if (clientId !== '' && clientSecret !== '' && enterpriseId !== '') {
    return { clientId, clientSecret, enterpriseId }
  }
  const refreshToken = process.env.BOX_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error(
      'Provide BOX_DEVELOPER_TOKEN, or BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_ENTERPRISE_ID (service account), or BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_REFRESH_TOKEN',
    )
  }
  return { clientId, clientSecret, refreshToken }
}

async function main(): Promise<void> {
  const vfs = new BoxVFS(buildConfig())
  const ws = new Workspace({ '/box': vfs }, { mode: MountMode.READ })
  const restore = patchNodeFs(ws)
  try {
    console.log('=== VFS MODE: fs.promises.* reads from Box transparently ===\n')
    const entries = await fs.promises.readdir('/box')
    for (const e of entries.slice(0, 10)) console.log(`  ${e}`)
    if (entries.length > 10) console.log(`  ... (${String(entries.length)} total)`)

    if (entries.length > 0) {
      const first = entries[0]!
      const path = `/box/${first}`
      const stat = await fs.promises.stat(path)
      console.log(`\n--- fs.stat(${path}) ---`)
      console.log(`  isDirectory: ${String(stat.isDirectory())} size: ${String(stat.size)}`)

      if (stat.isFile() && stat.size < 1024 * 1024) {
        const content = await fs.promises.readFile(path, 'utf-8')
        console.log(`  ${content.slice(0, 200)}...`)
      } else if (stat.isDirectory()) {
        const sub = await fs.promises.readdir(path)
        for (const s of sub.slice(0, 5)) console.log(`  ${s}`)
      }
    }
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
