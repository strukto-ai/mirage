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
import { MountMode, patchNodeFs, SSHVFS, type SSHConfig, Workspace } from '@struktoai/mirage-node'

const require = createRequire(import.meta.url)
const fs = require('fs') as typeof import('fs')

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function buildConfig(): SSHConfig {
  const host = process.env.SSH_HOST
  const username = process.env.SSH_USER
  if (host === undefined || host === '') throw new Error('SSH_HOST env var is required')
  if (username === undefined || username === '') throw new Error('SSH_USER env var is required')
  const cfg: SSHConfig = { host, username }
  if (process.env.SSH_KEY !== undefined && process.env.SSH_KEY !== '') {
    cfg.identityFile = process.env.SSH_KEY
  }
  if (process.env.SSH_PASSWORD !== undefined) cfg.password = process.env.SSH_PASSWORD
  if (process.env.SSH_PASSPHRASE !== undefined) cfg.passphrase = process.env.SSH_PASSPHRASE
  if (process.env.SSH_PORT !== undefined && process.env.SSH_PORT !== '') {
    cfg.port = Number(process.env.SSH_PORT)
  }
  if (process.env.SSH_ROOT !== undefined && process.env.SSH_ROOT !== '') {
    cfg.root = process.env.SSH_ROOT
  }
  return cfg
}

async function main(): Promise<void> {
  const MOUNT = '/ssh'
  const vfs = new SSHVFS(buildConfig())
  const ws = new Workspace({ [MOUNT]: vfs }, { mode: MountMode.WRITE })
  const restore = patchNodeFs(ws)
  try {
    console.log(`=== VFS MODE: mounted at ${MOUNT} (in-process fs patch) ===\n`)

    console.log(`--- fs.readdir() ${MOUNT} ---`)
    for (const r of await fs.promises.readdir(MOUNT)) console.log(`  ${r}`)

    const probe = `${MOUNT}/etc/hostname`
    console.log(`\n--- fs.stat() ${probe} ---`)
    try {
      const st = await fs.promises.stat(probe)
      console.log(`  size=${String(st.size)}`)
      const data = await fs.promises.readFile(probe, 'utf-8')
      console.log(`\n--- fs.readFile() ${probe} ---`)
      console.log(`  ${data.trim().slice(0, 200)}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  (skipped: ${msg})`)
    }

    const records = ws.records
    const total = records.reduce((acc, r) => acc + (r.bytes ?? 0), 0)
    console.log(`\nStats: ${String(records.length)} ops, ${String(total)} bytes transferred`)
  } finally {
    restore()
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
