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
import {
  MountMode,
  SeaweedFSResource,
  Workspace,
  type SeaweedFSConfig,
  type FileStat,
} from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): SeaweedFSConfig {
  return {
    bucket: process.env.SEAWEEDFS_BUCKET ?? 'mirage-demo',
    endpoint: process.env.SEAWEEDFS_ENDPOINT ?? 'http://localhost:8333',
    accessKeyId: process.env.SEAWEEDFS_ACCESS_KEY ?? 'any',
    secretAccessKey: process.env.SEAWEEDFS_SECRET_KEY ?? 'any',
  }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const ws = new Workspace(
    { '/seaweedfs/': new SeaweedFSResource(config) },
    { mode: MountMode.WRITE },
  )
  try {
    console.log(`=== SeaweedFS at ${config.endpoint} (bucket ${config.bucket}) ===`)

    // Seed a few objects so the demo is self-contained (WRITE mode).
    await ws.execute(
      `echo '{"event":"queue-operation","tool":"mirage"}' > /seaweedfs/data/example.jsonl`,
    )
    await ws.execute(`echo '{"event":"read","tool":"mirage"}' >> /seaweedfs/data/example.jsonl`)
    await ws.execute(
      `echo '{"event":"queue-operation","tool":"other"}' >> /seaweedfs/data/example.jsonl`,
    )
    await ws.execute(
      `echo '{"name":"mirage","version":1,"tags":["s3","seaweedfs"]}' > /seaweedfs/data/config.json`,
    )
    await ws.execute('echo "hello from seaweedfs" > /seaweedfs/notes.txt')


    // chmod/chown/touch never hit the SeaweedFS API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /seaweedfs/notes.txt ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/seaweedfs/notes.txt" && chown 500:dev "/seaweedfs/notes.txt" && touch -t 202601021530 "/seaweedfs/notes.txt"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/seaweedfs/notes.txt`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    console.log('\n--- ls /seaweedfs/ ---')
    let r = await ws.execute('ls /seaweedfs/')
    console.log(r.stdoutText)

    console.log('--- tree /seaweedfs/ ---')
    r = await ws.execute('tree /seaweedfs/')
    console.log(r.stdoutText)

    console.log('--- stat /seaweedfs/notes.txt ---')
    r = await ws.execute('stat /seaweedfs/notes.txt')
    console.log(`  ${r.stdoutText.trim()}`)

    console.log('\n--- cat /seaweedfs/notes.txt ---')
    r = await ws.execute('cat /seaweedfs/notes.txt')
    console.log(`  ${JSON.stringify(r.stdoutText.trim())}`)

    console.log('\n--- head -c 40 /seaweedfs/data/example.jsonl (byte range) ---')
    r = await ws.execute('head -c 40 /seaweedfs/data/example.jsonl')
    console.log(`  ${JSON.stringify(r.stdoutText.trim())}`)

    console.log('\n--- grep -c queue-operation /seaweedfs/data/example.jsonl ---')
    r = await ws.execute('grep -c queue-operation /seaweedfs/data/example.jsonl')
    console.log(`  count: ${r.stdoutText.trim()}`)

    console.log("--- find /seaweedfs/ -name '*.json' ---")
    r = await ws.execute("find /seaweedfs/ -name '*.json'")
    console.log(r.stdoutText)

    console.log('--- jq .tags /seaweedfs/data/config.json ---')
    r = await ws.execute('jq .tags /seaweedfs/data/config.json')
    console.log(`  ${r.stdoutText.trim()}`)

    console.log('\n--- PROVISION: cat (plan only) vs head -c (byte budget) ---')
    let plan = await ws.execute('cat /seaweedfs/data/example.jsonl', { provision: true })
    console.log(`  cat: network_read=${plan.networkRead} precision=${plan.precision}`)
    plan = await ws.execute('head -c 20 /seaweedfs/data/example.jsonl', { provision: true })
    console.log(`  head -c 20: network_read=${plan.networkRead} precision=${plan.precision}`)

    console.log('\n--- rm seeded objects ---')
    for (const key of [
      '/seaweedfs/data/example.jsonl',
      '/seaweedfs/data/config.json',
      '/seaweedfs/notes.txt',
    ]) {
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
