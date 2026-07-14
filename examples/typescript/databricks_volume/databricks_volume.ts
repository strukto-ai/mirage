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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  DatabricksVolumeResource,
  MountMode,
  Workspace,
  type FileStat,
  normalizeDatabricksVolumeConfig,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

async function run(ws: Workspace, cmd: string): Promise<void> {
  console.log(`\n>>> ${cmd}`)
  const result = await ws.execute(cmd)
  const stdout = result.stdoutText.trim()
  const stderr = result.stderrText.trim()
  if (stdout !== '') {
    const lines = stdout.split('\n')
    for (const line of lines.slice(0, 12)) {
      console.log(`  ${line.slice(0, 140)}`)
    }
    if (lines.length > 12) {
      console.log(`  ... (${String(lines.length)} lines total)`)
    }
  }
  if (stderr !== '') {
    console.log(`  [stderr] ${stderr.slice(0, 140)}`)
  }
  if (stdout === '' && stderr === '') {
    console.log(`  (empty, exit=${String(result.exitCode)})`)
  }
}

async function main(): Promise<void> {
  const config = normalizeDatabricksVolumeConfig({
    catalog: process.env.DATABRICKS_VOLUME_CATALOG!,
    schema: process.env.DATABRICKS_VOLUME_SCHEMA!,
    volume: process.env.DATABRICKS_VOLUME_NAME!,
    root_path: process.env.DATABRICKS_VOLUME_ROOT_PATH ?? '/',
    ...(process.env.DATABRICKS_HOST !== undefined ? { host: process.env.DATABRICKS_HOST } : {}),
    ...(process.env.DATABRICKS_TOKEN !== undefined ? { token: process.env.DATABRICKS_TOKEN } : {}),
    ...(process.env.DATABRICKS_CONFIG_PROFILE !== undefined
      ? { profile: process.env.DATABRICKS_CONFIG_PROFILE }
      : {}),
  })
  const resource = await DatabricksVolumeResource.create(config)
  const ws = new Workspace({ '/dbx/': resource }, { mode: MountMode.READ })
  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of ['cat /dbx/__nf_missing__.txt', 'head /dbx/__nf_missing__.txt', 'stat /dbx/__nf_missing__.txt']) {
      const res = await ws.execute(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(res.exitCode)}  ${new TextDecoder().decode(res.stderr).trim()}`)
    }

    await run(ws, 'ls /dbx/')
    await run(ws, 'tree -L 2 /dbx/')
    await run(ws, 'find /dbx/ -name "*.md"')

    const target = process.env.DATABRICKS_VOLUME_SAMPLE_FILE
    if (target !== undefined && target !== '') {
      await run(ws, `stat "${target}"`)
      await run(ws, `head -n 20 "${target}"`)
      await run(ws, `grep -n TODO "${target}"`)


      // chmod/chown/touch never hit the Databricks API: attrs land in the
      // workspace namespace (durable, snapshot-captured) and merge into
      // dispatch-level stat.
      console.log(`=== metadata overlay on ${target} ===`)
      const metaRes = await ws.execute(
        `chmod 640 "${target}" && chown 500:dev "${target}" && touch -t 202601021530 "${target}"`,
      )
      console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
      const metaSt = (await ws.dispatch('stat', `${target}`)) as FileStat
      const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
      console.log(
        `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
      )
    } else {
      console.log('\nSet DATABRICKS_VOLUME_SAMPLE_FILE to run file reads.')
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
