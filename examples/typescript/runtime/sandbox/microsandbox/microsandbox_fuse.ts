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

// The microVM guest has no /dev/fuse, so Mirage FUSE-mounts S3 on the HOST and
// Microsandbox bind-mounts that path in over virtio-fs. The guest reads it
// natively, with no S3 credentials and no network of its own.
// Requires the `msb` CLI on PATH, host FUSE (Linux fuse3), and AWS creds in
// .env.development. The microVM is booted with `msb run`, the same CLI
// Mirage's MicrosandboxRuntime drives, as a child process: this process's
// event loop serves the FUSE mount, so it must stay free while the guest reads.
// The guest script is the Python example's remote/guest.py.

import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  Mount,
  MountBackend,
  MountMode,
  S3VFS,
  Workspace,
  type S3Config,
} from '@struktoai/mirage-node'

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../../.env.development') })

const REMOTE_DIR = resolve(__HERE, '../../../../python/runtime/sandbox/microsandbox/remote')

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

// Run a child to completion without blocking the event loop. A non-zero
// exit is a result; a spawn failure is an error.
function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err === null) {
        resolveRun({ code: 0, stdout, stderr })
      } else if (typeof err.code === 'number') {
        resolveRun({ code: err.code, stdout, stderr })
      } else {
        reject(err)
      }
    })
  })
}

function requireEnv(key: string): string {
  const value = process.env[key]
  if (value === undefined) {
    throw new Error(`${key} not set (expected in .env.development)`)
  }
  return value
}

function s3Config(): S3Config {
  return {
    bucket: requireEnv('AWS_S3_BUCKET'),
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    accessKeyId: requireEnv('AWS_ACCESS_KEY_ID'),
    secretAccessKey: requireEnv('AWS_SECRET_ACCESS_KEY'),
  }
}

async function main(): Promise<void> {
  console.log('=== Mirage FUSE-mounting S3 on the host ===')
  const ws = new Workspace({
    '/s3/': new Mount(new S3VFS(s3Config()), {
      mode: MountMode.READ,
      backend: MountBackend.FUSE,
    }),
  })
  try {
    await ws.fuseReady()
    const hostS3 = ws.fuseMountpoint
    if (hostS3 === null) {
      throw new Error('FUSE mount failed; see the mirage warning above')
    }
    console.log(`  host mountpoint: ${hostS3}`)

    console.log('\n=== booting microVM (S3 mount bind-mounted in, no network) ===')
    const result = await run('msb', [
      'run',
      '--name',
      'mirage-fuse',
      '--replace',
      '--quiet',
      '--memory',
      '1024M',
      '--cpus',
      '1',
      '--volume',
      `${hostS3}:/s3:ro`,
      '--volume',
      `${REMOTE_DIR}:/prog:ro`,
      'python',
      '--',
      'python',
      '/prog/guest.py',
    ])
    console.log('=== guest output ===')
    console.log(result.stdout.trimEnd())
    if (result.code !== 0) {
      console.error(result.stderr)
      console.error(`\n=== exit code: ${String(result.code)} ===`)
      process.exitCode = result.code
      return
    }

    const records = ws.records
    const total = records.reduce((acc, rec) => acc + rec.bytes, 0)
    console.log(`\nMirage served ${String(records.length)} ops, ${String(total)} bytes to the sandbox`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
