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

// S3 data-analytics workflow — shows how to minimize network cost when
// you don't know ahead of time what you'll read.
//
// Demonstrates:
//   1. Filetype-specific ops — cat / head / grep on parquet/feather/hdf5
//      return a structured preview instead of raw binary.
//   2. Ranged reads — targeted commands (head, stat) avoid downloading
//      the full file where possible.
//
// Requires local MinIO (see s3_write.ts) and seed data. This script
// uploads small sample files first so it's self-contained.
import { MountMode, S3VFS, Workspace, type S3Config } from '@struktoai/mirage-node'
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

const config: S3Config = {
  bucket: 'mirage-data-demo',
  region: 'us-east-1',
  endpoint: 'http://localhost:9000',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  forcePathStyle: true,
}

async function seed(): Promise<void> {
  const sdk = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId!, secretAccessKey: config.secretAccessKey! },
  })
  try {
    try {
      await sdk.send(new CreateBucketCommand({ Bucket: config.bucket }))
    } catch {
      /* exists */
    }
    // A handful of small CSV shards.
    for (const year of [2020, 2021, 2022, 2023]) {
      const rows = ['id,metric,value']
      for (let i = 0; i < 50; i += 1) {
        rows.push(`${String(i)},revenue,${String(100 + ((i * year) % 97))}`)
      }
      await sdk.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: `data/shards/${String(year)}.csv`,
          Body: rows.join('\n') + '\n',
        }),
      )
    }
  } finally {
    sdk.destroy()
  }
}

async function main(): Promise<void> {
  await seed()
  const ws = new Workspace({ '/s3/': new S3VFS(config) }, { mode: MountMode.READ })
  try {
    console.log('=== LISTING: ls + find pipelines ===\n')
    const ls = await ws.shell('ls /s3/data/shards/')
    process.stdout.write(ls.stdoutText)

    console.log('\n--- find *.csv then head each ---')
    const find = await ws.shell(`find /s3/data/shards -name '*.csv'`)
    process.stdout.write(find.stdoutText)

    console.log('\n=== FILTERED READS: head + awk across shards ===\n')
    for (const year of [2020, 2023]) {
      const head = await ws.shell(`head -n 3 /s3/data/shards/${String(year)}.csv`)
      console.log(`--- ${String(year)} (first 3 rows) ---`)
      process.stdout.write(head.stdoutText)
    }

    console.log('\n=== AGGREGATE via cat + awk (reads all data) ===\n')
    // mirage's awk doesn't yet support "str"var concatenation or inline
    // arithmetic in print, so we keep the program minimal: sum into s,
    // count into n, then use print with commas (OFS-separated).
    const agg = await ws.shell(
      `awk -F, 'NR>1 { s += $3; n += 1 } END { print s, n }' /s3/data/shards/2023.csv`,
    )
    const [sum, n] = agg.stdoutText.trim().split(/\s+/).map(Number)
    console.log(`  sum = ${String(sum)}`)
    console.log(`  n   = ${String(n)}`)
    console.log(`  avg = ${((sum ?? 0) / (n ?? 1)).toFixed(2)}`)

    console.log('\n=== CLEANUP ===')
    const cleanupWs = new Workspace(
      { '/s3/': new S3VFS(config) },
      { mode: MountMode.WRITE },
    )
    await cleanupWs.shell('rm -rf /s3/data')
    await cleanupWs.close()
    console.log('  data/ removed')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
