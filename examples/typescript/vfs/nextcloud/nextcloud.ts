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
  NextcloudVFS,
  Workspace,
  type FileStat,
  type NextcloudConfig,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): NextcloudConfig {
  const url = process.env.NEXTCLOUD_URL
  if (url === undefined) throw new Error('NEXTCLOUD_URL is required')
  return {
    url,
    username: process.env.NEXTCLOUD_USERNAME,
    password: process.env.NEXTCLOUD_PASSWORD,
  }
}

async function main(): Promise<void> {
  const vfs = new NextcloudVFS(buildConfig())
  const ws = new Workspace({ '/nc/': vfs }, { mode: MountMode.WRITE })
  try {
    console.log('=== ls /nc/ ===')
    console.log((await ws.shell('ls /nc/')).stdoutText)

    console.log('=== tree -L 2 /nc/ ===')
    console.log((await ws.shell('tree -L 2 /nc/')).stdoutText)

    console.log('=== find /nc/ -type f ===')
    console.log((await ws.shell('find /nc/ -type f')).stdoutText)

    console.log('=== stat /nc/ ===')
    console.log((await ws.shell('stat /nc/')).stdoutText.trim())

    const testFile = `/nc/mirage-demo-${randomUUID().replaceAll('-', '').slice(0, 8)}.txt`
    const body = new TextEncoder().encode('hello from mirage\nline two\nthird line\n')

    console.log(`\n=== write ${testFile} ===`)
    await ws.vfs.write(testFile, body)
    console.log(`  wrote ${String(body.byteLength)} bytes`)

    console.log(`\n=== cat ${testFile} ===`)
    console.log((await ws.shell(`cat ${testFile}`)).stdoutText)

    console.log(`=== wc -l ${testFile} ===`)
    console.log((await ws.shell(`wc -l ${testFile}`)).stdoutText.trim())

    console.log(`=== head -n 2 ${testFile} ===`)
    console.log((await ws.shell(`head -n 2 ${testFile}`)).stdoutText)

    console.log(`=== grep line ${testFile} ===`)
    console.log((await ws.shell(`grep line ${testFile}`)).stdoutText)

    console.log(`=== sort ${testFile} | uniq ===`)
    console.log((await ws.shell(`sort ${testFile} | uniq`)).stdoutText)

    console.log(`=== cat ${testFile} | tr a-z A-Z ===`)
    console.log((await ws.shell(`cat ${testFile} | tr a-z A-Z`)).stdoutText)

    console.log(`=== sha256sum ${testFile} ===`)
    console.log((await ws.shell(`sha256sum ${testFile}`)).stdoutText.trim())

    // chmod/chown/touch never hit the WebDAV server: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${testFile} ===`)
    const metaRes = await ws.shell(
      `chmod 640 "${testFile}" && chown 500:dev "${testFile}" && touch -t 202601021530 "${testFile}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', testFile)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    console.log(`\n=== rm ${testFile} ===`)
    const rm = await ws.shell(`rm ${testFile}`)
    console.log(`  exit=${String(rm.exitCode)}`)

    console.log(`=== stat ${testFile} (expect failure) ===`)
    const gone = await ws.shell(`stat ${testFile}`)
    console.log(`  exit=${String(gone.exitCode)}  stderr=${gone.stderrText.trim().slice(0, 80)}`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
