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

// Read-only S3 demo against a public bucket.
//
// This example reads from one of the NOAA public datasets — a large, stable,
// unauthenticated S3 bucket. No credentials required. If you want to run
// against your own private bucket, set these env vars:
//
//   AWS_S3_BUCKET, AWS_DEFAULT_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//
// The example demonstrates:
//   - ls /s3/... (readdir)
//   - cat /s3/<small-file> (read)
//   - head -n 5 /s3/<file> (stream + backpressure)
//   - grep 'pattern' /s3/<file> (ranged read via GetObject)
//   - find /s3/... -name '*.txt' (find)
//   - stat /s3/<file> (HeadObject)
//
// Phase 1 is READ-ONLY. Writes (tee, cp, mv, rm, mkdir) will be added in
// Phase 2. See docs/plans for the roadmap.
import { MountMode, S3VFS, Workspace, type S3Config } from '@struktoai/mirage-node'

function configFromEnv(): S3Config {
  // Default: NOAA Global Historical Climatology Network daily data.
  // This bucket is publicly readable and safe for CI / demos.
  if (process.env.AWS_S3_BUCKET !== undefined) {
    return {
      bucket: process.env.AWS_S3_BUCKET,
      region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
      ...(process.env.AWS_ACCESS_KEY_ID !== undefined &&
      process.env.AWS_SECRET_ACCESS_KEY !== undefined
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : {}),
    }
  }
  return {
    bucket: 'noaa-ghcn-pds',
    region: 'us-east-1',
  }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  console.log(`=== S3VFS — bucket: ${config.bucket} (region: ${config.region ?? 'default'}) ===\n`)

  const vfs = new S3VFS(config)
  const ws = new Workspace({ '/s3/': vfs }, { mode: MountMode.READ })

  try {
    console.log('=== ls /s3/csv/by_year/ (first 10) ===')
    const ls = await ws.shell('ls /s3/csv/by_year/ | head -n 10')
    process.stdout.write(ls.stdoutText)
    console.log()

    console.log('=== stat /s3/readme.txt ===')
    const stat = await ws.shell('stat /s3/readme.txt')
    process.stdout.write(stat.stdoutText)
    console.log()

    console.log('=== head -n 5 /s3/readme.txt ===')
    const head = await ws.shell('head -n 5 /s3/readme.txt')
    process.stdout.write(head.stdoutText)
    console.log()

    console.log("=== grep 'NOAA' /s3/readme.txt | head -n 3 ===")
    const grep = await ws.shell("grep 'NOAA' /s3/readme.txt | head -n 3")
    process.stdout.write(grep.stdoutText)
    console.log()

    console.log('=== wc -l /s3/readme.txt ===')
    const wc = await ws.shell('wc -l /s3/readme.txt')
    process.stdout.write(wc.stdoutText)
    console.log()
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
