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
  DigitalOceanResource,
  Workspace,
  resolvedDigitalOceanEndpoint,
  type DigitalOceanConfig,
  type FileStat,
} from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): DigitalOceanConfig {
  const bucket = process.env.DO_SPACE
  const region = process.env.DO_REGION
  const accessKeyId = process.env.DO_ACCESS_KEY_ID
  const secretAccessKey = process.env.DO_SECRET_ACCESS_KEY
  if (bucket === undefined || region === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error('DO_SPACE, DO_REGION, DO_ACCESS_KEY_ID, DO_SECRET_ACCESS_KEY must be set (e.g. in .env.development)')
  }
  return { bucket, region, accessKeyId, secretAccessKey }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const ws = new Workspace({ '/do/': new DigitalOceanResource(config) }, { mode: MountMode.READ })
  try {
    console.log(`=== DigitalOcean Spaces at ${resolvedDigitalOceanEndpoint(config)} ===`)

    let r = await ws.execute('ls /do/')
    console.log('ls /do/:\n' + r.stdoutText)

    r = await ws.execute("find /do/ -name '*.json' | head -n 5")
    console.log('find *.json:\n' + r.stdoutText)

    const plan = await ws.execute('grep -m 1 mirage /do/data/example.jsonl', { provision: true })
    console.log(`plan grep -m 1: network_read=${plan.networkRead} precision=${plan.precision}`)

    const bytes = ws.records.reduce((acc, rec) => acc + rec.bytes, 0)
    console.log(`\nStats: ${String(ws.records.length)} ops, ${String(bytes)} bytes`)


    // chmod/chown/touch never hit the Spaces API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /do/data/example.jsonl ===`)
    const metaRes = await ws.execute(
      `chmod 640 "/do/data/example.jsonl" && chown 500:dev "/do/data/example.jsonl" && touch -t 202601021530 "/do/data/example.jsonl"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `/do/data/example.jsonl`)) as FileStat
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
