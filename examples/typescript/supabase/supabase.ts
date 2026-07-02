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
import { MountMode, SupabaseResource, Workspace, type FileStat, type SupabaseConfig } from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function configFromEnv(): SupabaseConfig {
  const bucket = process.env.SUPABASE_BUCKET
  const region = process.env.SUPABASE_REGION
  const accessKeyId = process.env.SUPABASE_ACCESS_KEY_ID
  const secretAccessKey = process.env.SUPABASE_SECRET_ACCESS_KEY
  if (
    bucket === undefined ||
    region === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    throw new Error(
      'SUPABASE_BUCKET, SUPABASE_REGION, SUPABASE_ACCESS_KEY_ID, SUPABASE_SECRET_ACCESS_KEY must be set (e.g. in .env.development); also provide SUPABASE_PROJECT_REF or SUPABASE_ENDPOINT_URL',
    )
  }
  const projectRef = process.env.SUPABASE_PROJECT_REF
  const endpoint = process.env.SUPABASE_ENDPOINT_URL
  if (projectRef === undefined && endpoint === undefined) {
    throw new Error('SUPABASE_PROJECT_REF or SUPABASE_ENDPOINT_URL must be set')
  }
  const sessionToken = process.env.SUPABASE_SESSION_TOKEN
  return {
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    ...(projectRef !== undefined ? { projectRef } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(sessionToken !== undefined ? { sessionToken } : {}),
  }
}

async function run(
  ws: Workspace,
  command: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const r = await ws.execute(command)
  return { stdout: r.stdoutText, stderr: r.stderrText, exitCode: r.exitCode }
}

async function main(): Promise<void> {
  const config = configFromEnv()
  const resource = new SupabaseResource(config)
  const ws = new Workspace({ '/supabase/': resource }, { mode: MountMode.WRITE })

  try {
    console.log('=== ls /supabase/ ===')
    console.log((await run(ws, 'ls /supabase/')).stdout)

    console.log('=== tree /supabase/ ===')
    console.log((await run(ws, 'tree /supabase/')).stdout)

    const stamp = Date.now()
    const key = `/supabase/ts-demo/${String(stamp)}.txt`
    console.log(`\n=== echo > ${key} ===`)
    const writeResult = await run(ws, `echo 'hello from TS Supabase' > ${key}`)
    console.log(`  exit=${String(writeResult.exitCode)}${writeResult.stderr ? `  stderr=${writeResult.stderr}` : ''}`)
    if (writeResult.exitCode !== 0) {
      // Free-tier Supabase pauses idle projects; every S3 call then
      // returns HTTP 540, which the SDK reports as a deserialization
      // error. Bail out with a hint instead of failing every section.
      console.log('supabase mount unavailable (paused project or bad creds);')
      console.log('unpause the project in the Supabase dashboard and rerun')
      return
    }

    console.log(`\n=== cat ${key} ===`)
    console.log(`  ${(await run(ws, `cat ${key}`)).stdout.trim()}`)

    console.log(`\n=== stat ${key} ===`)
    console.log(`  ${(await run(ws, `stat ${key}`)).stdout.trim()}`)

    console.log(`\n=== wc -c ${key} ===`)
    console.log(`  ${(await run(ws, `wc -c ${key}`)).stdout.trim()}`)

    console.log(`\n=== ls /supabase/ts-demo/ ===`)
    console.log((await run(ws, 'ls /supabase/ts-demo/')).stdout)


    // chmod/chown/touch never hit the Storage API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${key} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "${key}" && chown 500:dev "${key}" && touch -t 202601021530 "${key}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    try {
      const metaSt = (await ws.dispatch('stat', `${key}`)) as FileStat
      const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
      console.log(
        `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
      )
    } catch {
      console.log('  dispatch stat: target unavailable (check bucket contents)')
    }

    console.log(`\n=== rm ${key} ===`)
    const rmResult = await run(ws, `rm ${key}`)
    console.log(`  exit=${String(rmResult.exitCode)}`)
  } finally {
    await ws.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
