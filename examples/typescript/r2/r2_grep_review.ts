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

import dotenv from 'dotenv'
import { MountMode, R2VFS, Workspace, type R2Config } from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): R2Config {
  const bucket = process.env.R2_BUCKET
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error('R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY must be set')
  }
  const accountId = process.env.R2_ACCOUNT_ID
  const endpoint = process.env.R2_ENDPOINT_URL
  const region = process.env.R2_REGION
  if (accountId === undefined && endpoint === undefined) {
    throw new Error('R2 requires R2_ACCOUNT_ID or R2_ENDPOINT_URL')
  }
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(region !== undefined ? { region } : {}),
  }
}

async function run(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n$ ${cmd}`)
  const r = await ws.shell(cmd)
  console.log('--- stdout ---')
  console.log(r.stdoutText.trim())
  if (r.stderrText.trim().length > 0) {
    console.log('--- stderr ---')
    console.log(r.stderrText.trim())
  }
  console.log(`--- exit ${String(r.exitCode)} ---`)
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const vfs = new R2VFS(config)
  const ws = new Workspace({ '/r2/': vfs }, { mode: MountMode.READ })
  try {
    await run(ws, 'find /r2/Review -maxdepth 3 -type f')
    await run(ws, 'echo ---')
    await run(ws, 'grep -RIl "Base3\\|base3" /r2/Review || true')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
