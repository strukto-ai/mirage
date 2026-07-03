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

import { MountMode, S3Resource, Workspace } from '@struktoai/mirage-node'
import { runCases } from './cases.ts'

async function main(): Promise<void> {
  const bucket = process.env.S3_BUCKET
  if (bucket === undefined || bucket === '') {
    throw new Error('S3_BUCKET env required (point at MinIO or AWS bucket)')
  }
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION ?? 'us-east-1'
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const runId = `${String(process.pid)}-${String(Date.now())}`
  const common = {
    bucket,
    region,
    ...(endpoint !== undefined && endpoint !== '' ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId !== undefined && accessKeyId !== '' ? { accessKeyId } : {}),
    ...(secretAccessKey !== undefined && secretAccessKey !== '' ? { secretAccessKey } : {}),
  }
  const resource = new S3Resource({ ...common, keyPrefix: `mirage-integ-${runId}/` })
  const resource2 = new S3Resource({ ...common, keyPrefix: `mirage-integ-xm-${runId}/` })
  const ws = new Workspace(
    { '/data': resource, '/data2': resource2 },
    { mode: MountMode.WRITE },
  )
  try {
    await runCases(ws)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
