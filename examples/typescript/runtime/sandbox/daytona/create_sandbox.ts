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

// Create a sandbox from the mirage-fuse snapshot, provision the
// in-sandbox workspace (S3 FUSE-mounted at /data, the same prefix the
// host workspace uses), and print the sandbox id. The sandbox is
// yours: mirage only connects to it, so delete it when done
// (`daytona sandbox delete <id>` or the dashboard). The lifecycle
// knobs below are the safety net for a forgotten demo box.

import { Daytona, type Sandbox } from '@daytona/sdk'
import dotenv from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../../.env.development') })

const SNAPSHOT_NAME = 'mirage-fuse'

function requireEnv(key: string): string {
  const value = process.env[key]
  if (value === undefined) {
    throw new Error(`${key} not set (expected in .env.development)`)
  }
  return value
}

// The sandbox-side workspace config: same mount, same prefix as
// daytona_workspace.yaml, FUSE-mounted at its own prefix so host and
// sandbox paths mean the same thing.
function workspaceYaml(): string {
  return [
    'mounts:',
    '  /data:',
    '    vfs: s3',
    '    config:',
    `      bucket: ${requireEnv('AWS_S3_BUCKET')}`,
    `      region: ${process.env.AWS_DEFAULT_REGION ?? 'us-east-1'}`,
    `      aws_access_key_id: ${requireEnv('AWS_ACCESS_KEY_ID')}`,
    `      aws_secret_access_key: ${requireEnv('AWS_SECRET_ACCESS_KEY')}`,
    '      key_prefix: mirage-daytona-cli-demo',
    '    backend: fuse',
    '    mountpoint: /data',
    '',
  ].join('\n')
}

async function provision(sandbox: Sandbox): Promise<void> {
  await sandbox.fs.uploadFile(Buffer.from(workspaceYaml()), '/tmp/sandbox.yaml')
  const commands = [
    'sudo mkdir -p /data && sudo chown daytona /data',
    'mirage workspace create /tmp/sandbox.yaml',
  ]
  for (const command of commands) {
    const response = await sandbox.process.executeCommand(command)
    if (response.exitCode !== 0) {
      throw new Error(`provisioning failed (${command}): ${response.result}`)
    }
  }
  console.error('provisioned: S3 FUSE-mounted at /data in the sandbox')
}

async function main(): Promise<void> {
  const daytona = new Daytona()
  try {
    const sandbox = await daytona.create({
      snapshot: SNAPSHOT_NAME,
      autoStopInterval: 10,
      autoDeleteInterval: 30,
    })
    await provision(sandbox)
    console.log(sandbox.id)
  } finally {
    await daytona[Symbol.asyncDispose]()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
