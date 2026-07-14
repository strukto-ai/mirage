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
  QingStorResource,
  Workspace,
  resolvedQingStorEndpoint,
  type QingStorConfig,
  type FileStat,
} from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): QingStorConfig {
  const bucket = process.env.QINGSTOR_BUCKET
  const accessKeyId = process.env.QINGSTOR_ACCESS_KEY_ID
  const secretAccessKey = process.env.QINGSTOR_SECRET_ACCESS_KEY
  if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error('QINGSTOR_BUCKET, QINGSTOR_ACCESS_KEY_ID, QINGSTOR_SECRET_ACCESS_KEY must be set (e.g. in .env.development)')
  }
  const region = process.env.QINGSTOR_ZONE ?? 'pek3a'
  const endpoint = process.env.QINGSTOR_ENDPOINT_URL
  return { bucket, accessKeyId, secretAccessKey, region, ...(endpoint !== undefined ? { endpoint } : {}) }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const ws = new Workspace({ '/qs/': new QingStorResource(config) }, { mode: MountMode.READ })
  try {
    console.log(`=== QingStor at ${resolvedQingStorEndpoint(config)} ===`)

    let r = await ws.execute('ls /qs/')
    console.log('ls /qs/:\n' + r.stdoutText)

    r = await ws.execute("find /qs/ -name '*.json' | head -n 5")
    console.log('find *.json:\n' + r.stdoutText)

    const plan = await ws.execute('grep -m 1 mirage /qs/data/example.jsonl', { provision: true })
    console.log(`plan grep -m 1: network_read=${plan.networkRead} precision=${plan.precision}`)

    const bytes = ws.records.reduce((acc, rec) => acc + rec.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(bytes)} bytes`)


    // chmod/chown/touch never hit the QingStor API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /qs/data/example.jsonl ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/qs/data/example.jsonl" && chown 500:dev "/qs/data/example.jsonl" && touch -t 202601021530 "/qs/data/example.jsonl"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/qs/data/example.jsonl`)) as FileStat
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
