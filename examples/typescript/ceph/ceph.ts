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
  CephResource,
  Workspace,
  type CephConfig,
  type FileStat,
} from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): CephConfig {
  const bucket = process.env.CEPH_BUCKET
  const endpoint = process.env.CEPH_ENDPOINT_URL
  const accessKeyId = process.env.CEPH_ACCESS_KEY_ID
  const secretAccessKey = process.env.CEPH_SECRET_ACCESS_KEY
  if (bucket === undefined || endpoint === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error('CEPH_BUCKET, CEPH_ENDPOINT_URL, CEPH_ACCESS_KEY_ID, CEPH_SECRET_ACCESS_KEY must be set (e.g. in .env.development)')
  }
  return { bucket, endpoint, accessKeyId, secretAccessKey }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const ws = new Workspace({ '/ceph/': new CephResource(config) }, { mode: MountMode.READ })
  try {
    console.log(`=== Ceph RGW at ${config.endpoint} ===`)

    let r = await ws.execute('ls /ceph/')
    console.log('ls /ceph/:\n' + r.stdoutText)

    r = await ws.execute("find /ceph/ -name '*.json' | head -n 5")
    console.log('find *.json:\n' + r.stdoutText)

    const plan = await ws.execute('grep -m 1 mirage /ceph/data/example.jsonl', { provision: true })
    console.log(`plan grep -m 1: network_read=${plan.networkRead} precision=${plan.precision}`)

    const bytes = ws.records.reduce((acc, rec) => acc + rec.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(bytes)} bytes`)


    // chmod/chown/touch never hit the RGW API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /ceph/data/example.jsonl ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/ceph/data/example.jsonl" && chown 500:dev "/ceph/data/example.jsonl" && touch -t 202601021530 "/ceph/data/example.jsonl"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/ceph/data/example.jsonl`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
