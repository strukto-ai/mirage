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
import { MinIOResource, MountMode, Workspace, type FileStat, type MinIOConfig } from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): MinIOConfig {
  return {
    bucket: process.env.MINIO_BUCKET ?? 'mirage-demo',
    endpoint: process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const ws = new Workspace({ '/minio/': new MinIOResource(config) }, { mode: MountMode.WRITE })
  try {
    console.log(`=== MinIO at ${config.endpoint} (bucket ${config.bucket}) ===`)

    // Seed a few objects so the demo is self-contained (WRITE mode).
    await ws.execute(`echo '{"event":"queue-operation","tool":"mirage"}' > /minio/data/example.jsonl`)
    await ws.execute(`echo '{"event":"read","tool":"mirage"}' >> /minio/data/example.jsonl`)
    await ws.execute(`echo '{"event":"queue-operation","tool":"other"}' >> /minio/data/example.jsonl`)
    await ws.execute(`echo '{"name":"mirage","version":1,"tags":["s3","minio"]}' > /minio/data/config.json`)
    await ws.execute('echo "hello from minio" > /minio/notes.txt')


    // chmod/chown/touch never hit the MinIO API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /minio/notes.txt ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/minio/notes.txt" && chown 500:dev "/minio/notes.txt" && touch -t 202601021530 "/minio/notes.txt"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/minio/notes.txt`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    console.log('\n--- ls /minio/ ---')
    let r = await ws.execute('ls /minio/')
    console.log(r.stdoutText)

    console.log('--- tree /minio/ ---')
    r = await ws.execute('tree /minio/')
    console.log(r.stdoutText)

    console.log('--- stat /minio/notes.txt ---')
    r = await ws.execute('stat /minio/notes.txt')
    console.log(`  ${r.stdoutText.trim()}`)

    console.log('\n--- cat /minio/notes.txt ---')
    r = await ws.execute('cat /minio/notes.txt')
    console.log(`  ${JSON.stringify(r.stdoutText.trim())}`)

    console.log('\n--- head -c 40 /minio/data/example.jsonl (byte range) ---')
    r = await ws.execute('head -c 40 /minio/data/example.jsonl')
    console.log(`  ${JSON.stringify(r.stdoutText.trim())}`)

    console.log('\n--- grep -c queue-operation /minio/data/example.jsonl ---')
    r = await ws.execute('grep -c queue-operation /minio/data/example.jsonl')
    console.log(`  count: ${r.stdoutText.trim()}`)

    console.log("--- find /minio/ -name '*.json' ---")
    r = await ws.execute("find /minio/ -name '*.json'")
    console.log(r.stdoutText)

    console.log('--- jq .tags /minio/data/config.json ---')
    r = await ws.execute('jq .tags /minio/data/config.json')
    console.log(`  ${r.stdoutText.trim()}`)

    console.log('\n--- PROVISION: cat (plan only) vs head -c (byte budget) ---')
    let plan = await ws.execute('cat /minio/data/example.jsonl', { provision: true })
    console.log(`  cat: network_read=${plan.networkRead} precision=${plan.precision}`)
    plan = await ws.execute('head -c 20 /minio/data/example.jsonl', { provision: true })
    console.log(`  head -c 20: network_read=${plan.networkRead} precision=${plan.precision}`)

    console.log('\n--- rm seeded objects ---')
    for (const key of ['/minio/data/example.jsonl', '/minio/data/config.json', '/minio/notes.txt']) {
      await ws.execute(`rm ${key}`)
    }
    console.log('  cleaned')

    const bytes = ws.records.reduce((acc, rec) => acc + rec.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(bytes)} bytes transferred`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
