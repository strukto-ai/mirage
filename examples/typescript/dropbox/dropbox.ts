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
import { DropboxResource, MountMode, Workspace, type FileStat, type DropboxConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): DropboxConfig {
  const clientId = process.env.DROPBOX_APP_KEY ?? ''
  const clientSecret = process.env.DROPBOX_APP_SECRET ?? ''
  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('DROPBOX_APP_KEY / DROPBOX_APP_SECRET / DROPBOX_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

async function show(ws: Workspace, cmd: string, max = 600): Promise<string> {
  console.log(`=== ${cmd} ===`)
  try {
    const r = await ws.execute(cmd)
    const out = r.stdoutText
    if (out !== '') console.log(out.length > max ? out.slice(0, max) + '...' : out)
    if (r.stderrText !== '') process.stderr.write(`  STDERR: ${r.stderrText.trim().slice(0, 200)}\n`)
    return out
  } catch (err) {
    process.stderr.write(`  ERROR: ${err instanceof Error ? err.message : String(err)}\n`)
    return ''
  }
}

function quote(p: string): string {
  return `"${p}"`
}

async function main(): Promise<void> {
  const resource = new DropboxResource(buildConfig())
  const ws = new Workspace({ '/dropbox': resource }, { mode: MountMode.READ })
  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of ['cat /dropbox/__nf_missing__.txt', 'head /dropbox/__nf_missing__.txt', 'stat /dropbox/__nf_missing__.txt']) {
      const res = await ws.execute(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(res.exitCode)}  ${new TextDecoder().decode(res.stderr).trim()}`)
    }

    await show(ws, 'ls /dropbox/')
    await show(ws, 'tree -L 2 /dropbox/', 1200)
    await show(ws, 'du -h /dropbox/')

    const found = await show(ws, 'find /dropbox -type f -maxdepth 3', 1200)
    const files = found
      .trim()
      .split('\n')
      .filter((s) => s !== '')
    if (files.length === 0) {
      console.log('No files found under /dropbox/, upload something to exercise read commands.')
      return
    }
    const f1 = files[0]!
    const f2 = files[1] ?? f1

    await show(ws, `stat ${quote(f1)}`)


    // chmod/chown/touch never hit the Dropbox API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${f1} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "${f1}" && chown 500:dev "${f1}" && touch -t 202601021530 "${f1}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `${f1}`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )
    await show(ws, `file ${quote(f1)}`)
    await show(ws, `head -n 5 ${quote(f1)}`)
    await show(ws, `tail -n 3 ${quote(f1)}`)
    await show(ws, `nl ${quote(f1)} | head -n 5`)
    await show(ws, `wc ${quote(f1)} ${quote(f2)}`)
    await show(ws, `cat ${quote(f1)} ${quote(f2)} | wc -c`)
    await show(ws, `sort ${quote(f1)} | head -n 3`)
    await show(ws, `uniq ${quote(f1)} | wc -l`)
    await show(ws, `cut -c 1-40 ${quote(f1)} | head -n 3`)
    await show(ws, `sed -n 1,2p ${quote(f1)}`)
    await show(ws, `cat ${quote(f1)} | sed 's/[0-9]/#/g' | head -n 3`)
    // -i is rejected on the read-only Dropbox mount (sed is read-transform here)
    await show(ws, `sed -i s/x/y/ ${quote(f1)}`)
    await show(ws, `grep -c "." ${quote(f1)}`)
    await show(ws, 'grep -rl "a" /dropbox/ | head -n 5', 400)
    await show(ws, 'rg -l "a" /dropbox/ | head -n 5', 400)
    await show(ws, `find /dropbox -type f -name "*.json" -maxdepth 3 | head -n 5`)
    await show(ws, 'du -a /dropbox/ | head -n 8')

    const json = files.find((p) => p.endsWith('.json'))
    if (json !== undefined) {
      await show(ws, `jq -r "keys | .[]" ${quote(json)} | head -n 5`)
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
