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

import { CreateSandboxFromImageParams, Daytona } from '@daytona/sdk'
import dotenv from 'dotenv'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { baseImage, remoteEnv } from './remote_env.js'

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

const REMOTE_SCRIPT = resolve(__HERE, '../../../python/runtimes/daytona/remote/vfs.py')

async function main(): Promise<void> {
  const apiKey = process.env.DAYTONA_API_KEY
  if (apiKey === undefined) {
    throw new Error('DAYTONA_API_KEY not set (expected in .env.development)')
  }

  const daytona = new Daytona({ apiKey })

  console.log('=== building image (debian-slim + git + mirage-ai[s3]) ===')
  const sandbox = await daytona.create(
    {
      image: baseImage(),
      resources: { cpu: 1, memory: 1, disk: 1 },
    } as CreateSandboxFromImageParams,
    {
      timeout: 600,
      onSnapshotCreateLogs: (line: string) => console.log(`  build: ${line}`),
    },
  )
  console.log(`\n=== sandbox up: ${sandbox.id} ===\n`)

  try {
    await sandbox.fs.uploadFile(readFileSync(REMOTE_SCRIPT), '/tmp/run.py')
    const result = await sandbox.process.executeCommand(
      'python /tmp/run.py',
      '/tmp',
      remoteEnv(),
      120,
    )
    console.log('=== remote output ===')
    console.log(result.result.trimEnd())
    if (result.exitCode !== 0) {
      console.error(`\n=== exit code: ${String(result.exitCode)} ===`)
      process.exit(result.exitCode)
    }
  } finally {
    console.log(`\n=== deleting sandbox ${sandbox.id} ===`)
    await sandbox.delete()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
