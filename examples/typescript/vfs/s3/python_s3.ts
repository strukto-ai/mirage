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

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { Mount, MountMode, RAMVFS, S3VFS, Workspace, type S3Config } from '@struktoai/mirage-node'

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

function baseConfig(): S3Config {
  const bucket = process.env.AWS_S3_BUCKET
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      'AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY must be set (e.g. in .env.development)',
    )
  }
  return {
    bucket,
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
  }
}

// Monty file handles are not iterable; readlines() works.
const SCRIPT = `
import json

with open("/s3/data/example.jsonl") as f:
    lines = f.readlines()
for i, line in enumerate(lines[:5]):
    rec = json.loads(line)
    print(f"[{i}] {json.dumps(rec)[:120]}...")
`

async function main(): Promise<void> {
  const ws = new Workspace(
    {
      '/s3/': new S3VFS(baseConfig()),
      // The demo scripts live under /work, so the mount carries x.
      '/work/': new Mount(new RAMVFS(), { mode: MountMode.EXEC }),
    },
    { mode: MountMode.EXEC },
  )
  try {
    console.log('=== Python exec: read first 5 lines of JSONL from S3 ===\n')

    await ws.shell('mkdir /work/scripts')
    await ws.shell(`echo '${SCRIPT}' > /work/scripts/read_jsonl.py`)

    console.log('--- python3 /work/scripts/read_jsonl.py ---')
    let result = await ws.shell('python3 /work/scripts/read_jsonl.py')
    console.log(result.stdoutText)
    if (result.stderr.length > 0) console.log('STDERR:', result.stderrText)
    console.log(`Exit code: ${String(result.exitCode)}`)
    const total = ws.records.reduce((acc, r) => acc + r.bytes, 0)
    console.log(`Stats: ${String(ws.records.length)} ops, ${String(total)} bytes transferred`)

    console.log('\n--- shell equivalent: head -n 5 ---')
    result = await ws.shell('head -n 5 /s3/data/example.jsonl')
    console.log(result.stdoutText)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
