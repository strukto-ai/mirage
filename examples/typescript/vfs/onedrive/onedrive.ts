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

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  MountMode,
  OneDriveVFS,
  Workspace,
  type FileStat,
  type OneDriveConfig,
} from '@struktoai/mirage-node'
import { graphList } from '@struktoai/mirage-core/core/msgraph/client'
import { driveLoc } from '@struktoai/mirage-core/core/onedrive/client'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): OneDriveConfig {
  const accessToken = process.env.MS_GRAPH_DRIVE_TOKEN
  if (accessToken === undefined) throw new Error('MS_GRAPH_DRIVE_TOKEN is required')
  const driveId = process.env.MS_GRAPH_DRIVE_ID ?? ''
  return { accessToken, ...(driveId !== '' ? { driveId } : {}) }
}

const backend = new OneDriveVFS(buildConfig())
const ws = new Workspace({ '/onedrive/': backend }, { mode: MountMode.WRITE })

const TEST_KEY = `mirage_onedrive_example-${randomUUID().replaceAll('-', '').slice(0, 8)}.txt`
const TEST_FILE = `/onedrive/${TEST_KEY}`

/**
 * Write this run's scratch file, refusing to replace one already there.
 *
 * The name is unique per run, so cleanup can delete it knowing nothing
 * else was stored under it.
 */
async function createTestFile(): Promise<void> {
  if ((await ws.shell(`stat ${TEST_FILE}`)).exitCode === 0) {
    throw new Error(`${TEST_FILE} already exists, not touching it`)
  }
  const r = await ws.shell(`echo 'hello from mirage onedrive' > ${TEST_FILE}`)
  if (r.exitCode !== 0) throw new Error(`write ${TEST_FILE} failed: ${r.stderrText.trim()}`)
}

async function exercise(): Promise<void> {
  console.log('=== cat it back ===')
  console.log((await ws.shell(`cat ${TEST_FILE}`)).stdoutText)

  console.log("=== sed read-transform: cat | sed 's/hello/HELLO/' ===")
  console.log((await ws.shell(`cat ${TEST_FILE} | sed 's/hello/HELLO/'`)).stdoutText)

  console.log('=== stat (fingerprint = cTag) ===')
  console.log((await ws.shell(`stat ${TEST_FILE}`)).stdoutText)

  // chmod/chown/touch never hit the Graph API: attrs land in the
  // workspace namespace (durable, snapshot-captured) and merge into
  // dispatch-level stat.
  console.log(`=== metadata overlay on ${TEST_FILE} ===`)
  const metaRes = await ws.shell(
    `chmod 640 "${TEST_FILE}" && chown 500:dev "${TEST_FILE}" && touch -t 202601021530 "${TEST_FILE}"`,
  )
  console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
  const metaSt = (await ws.dispatch('stat', TEST_FILE)) as FileStat
  const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
  console.log(
    `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
  )

  console.log('=== overwrite (creates a new version) ===')
  await ws.shell(`echo 'second version' > ${TEST_FILE}`)
  console.log((await ws.shell(`cat ${TEST_FILE}`)).stdoutText)

  console.log('=== version history ===')
  const config = backend.accessor.config
  const versions = await graphList(config, driveLoc(config, TEST_KEY).item('/versions'))
  for (const v of versions) {
    console.log(
      `  version ${String(v.id)}  size=${String(v.size)}  ` +
        `modified=${String(v.lastModifiedDateTime)}`,
    )
  }
}

async function main(): Promise<void> {
  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of [
      'cat /onedrive/__nf_missing__.txt',
      'head /onedrive/__nf_missing__.txt',
      'stat /onedrive/__nf_missing__.txt',
    ]) {
      const result = await ws.shell(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(result.exitCode)}  ${result.stderrText.trim()}`)
    }

    console.log('=== ls /onedrive/ (top level) ===')
    console.log((await ws.shell('ls /onedrive/')).stdoutText || '(empty)')

    console.log(`\n=== write ${TEST_FILE} ===`)
    await createTestFile()
    try {
      await exercise()
    } finally {
      console.log('\n=== cleanup ===')
      const r = await ws.shell(`rm ${TEST_FILE}`)
      if (r.exitCode !== 0) console.log(`  rm ${TEST_FILE} failed: ${r.stderrText.trim()}`)
    }
    console.log('done')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
