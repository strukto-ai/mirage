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
import { BoxResource, MountMode, Workspace, type BoxConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): BoxConfig {
  const devToken = process.env.BOX_DEVELOPER_TOKEN ?? process.env.BOX_ACCESS_TOKEN ?? ''
  if (devToken !== '') {
    return { accessToken: devToken }
  }
  const clientId = process.env.BOX_CLIENT_ID ?? ''
  const clientSecret = process.env.BOX_CLIENT_SECRET ?? ''
  const enterpriseId = process.env.BOX_ENTERPRISE_ID ?? ''
  if (clientId !== '' && clientSecret !== '' && enterpriseId !== '') {
    return { clientId, clientSecret, enterpriseId }
  }
  const refreshToken = process.env.BOX_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error(
      'Provide BOX_DEVELOPER_TOKEN, or BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_ENTERPRISE_ID (service account), or BOX_CLIENT_ID + BOX_CLIENT_SECRET + BOX_REFRESH_TOKEN',
    )
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
  const resource = new BoxResource(buildConfig())
  const ws = new Workspace({ '/box': resource }, { mode: MountMode.READ })
  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of ['cat /box/__nf_missing__.txt', 'head /box/__nf_missing__.txt', 'stat /box/__nf_missing__.txt']) {
      const res = await ws.execute(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(res.exitCode)}  ${new TextDecoder().decode(res.stderr).trim()}`)
    }

    await show(ws, 'ls /box/')
    await show(ws, 'tree -L 2 /box/', 1200)
    await show(ws, 'du -h /box/')

    const found = await show(ws, 'find /box -type f -maxdepth 3', 1200)
    const files = found
      .trim()
      .split('\n')
      .filter((s) => s !== '')
    if (files.length === 0) {
      console.log('No files found under /box/, upload something to exercise read commands.')
      return
    }
    const f1 = files[0]!
    const f2 = files[1] ?? f1

    await show(ws, `stat ${quote(f1)}`)
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
    // -i is rejected on the read-only Box mount (sed is read-transform here)
    await show(ws, `sed -i s/x/y/ ${quote(f1)}`)
    await show(ws, `grep -c "." ${quote(f1)}`)
    await show(ws, 'grep -rl "a" /box/ | head -n 5', 400)
    await show(ws, 'rg -l "a" /box/ | head -n 5', 400)
    await show(ws, `find /box -type f -name "*.json" -maxdepth 3 | head -n 5`)
    await show(ws, 'du -a /box/ | head -n 8')

    const json = files.find((p) => p.endsWith('.json'))
    if (json !== undefined) {
      await show(ws, `jq -r "keys | .[]" ${quote(json)} | head -n 5`)
    }
    const note = files.find((p) => p.endsWith('.boxnote.json') || p.endsWith('.gdoc.json'))
    if (note !== undefined) {
      await show(ws, `jq -r .body_text ${quote(note)} | head -n 5`)
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
