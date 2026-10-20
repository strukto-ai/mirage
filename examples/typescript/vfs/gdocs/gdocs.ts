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
import { GDocsVFS, GWS, MountMode, Workspace, type FileStat, type GDocsConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): GDocsConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

async function main(): Promise<void> {
  const config = buildConfig()
  const vfs = new GDocsVFS(config)
  const ws = new Workspace({ '/gdocs': vfs }, { mode: MountMode.WRITE })
  // The gws verbs are a CLI install, separate from the mount.
  ws.registerCli('gws', GWS, { ...config })
  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of [
      'cat /gdocs/__nf_missing__.txt',
      'head /gdocs/__nf_missing__.txt',
      'stat /gdocs/__nf_missing__.txt',
    ]) {
      const res = await ws.shell(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(res.exitCode)}  ${res.stderrText.trim()}`)
    }

    console.log('=== ls /gdocs/ ===')
    let r = await ws.shell('ls /gdocs/')
    console.log(r.stdoutText)

    console.log('=== ls /gdocs/owned/ (first 5) ===')
    r = await ws.shell('ls /gdocs/owned/ | head -n 5')
    console.log(r.stdoutText)

    const first = r.stdoutText.trim().split('\n')[0] ?? ''
    if (first === '') {
      console.log('no docs in /gdocs/owned/')
      return
    }
    const path = `/gdocs/owned/${first}`

    console.log('=== cat ===')
    r = await ws.shell(`cat "${path}"`)
    console.log(r.stdoutText.slice(0, 300))

    console.log('\n=== head -n 20 ===')
    r = await ws.shell(`head -n 20 "${path}"`)
    console.log(r.stdoutText)

    console.log('=== head -c 200 ===')
    r = await ws.shell(`head -c 200 "${path}"`)
    console.log(r.stdoutText)

    console.log('=== tail -n 10 ===')
    r = await ws.shell(`tail -n 10 "${path}"`)
    console.log(r.stdoutText)

    console.log('=== tail -c 200 ===')
    r = await ws.shell(`tail -c 200 "${path}"`)
    console.log(r.stdoutText)

    console.log('=== wc ===')
    r = await ws.shell(`wc "${path}"`)
    console.log(r.stdoutText)

    console.log('=== stat ===')
    r = await ws.shell(`stat "${path}"`)
    console.log(r.stdoutText)

    // chmod/chown/touch never hit the Docs API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${path} ===`)
    r = await ws.shell(
      `chmod 640 "${path}" && chown 500:dev "${path}" && touch -t 202601021530 "${path}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(r.exitCode)}`)
    const st = (await ws.dispatch('stat', path)) as FileStat
    const mode = st.mode !== null ? st.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${mode} uid=${String(st.uid)} gid=${String(st.gid)} mtime=${String(st.modified)}`,
    )

    console.log('=== jq .title ===')
    r = await ws.shell(`jq ".title" "${path}"`)
    console.log(r.stdoutText)

    console.log('=== nl ===')
    r = await ws.shell(`nl "${path}" | head -n 10`)
    console.log(r.stdoutText)

    console.log('=== tree /gdocs/ ===')
    r = await ws.shell('tree /gdocs/')
    console.log(r.stdoutText.slice(0, 500))

    console.log('\n=== find /gdocs/owned/ ===')
    r = await ws.shell("find /gdocs/owned/ -name '*.gdoc.json' | head -n 5")
    console.log(r.stdoutText)

    console.log('=== grep textRun ===')
    r = await ws.shell(`grep textRun "${path}" | head -c 200`)
    console.log(r.stdoutText)

    console.log('\n=== rg textRun ===')
    r = await ws.shell(`rg textRun "${path}" | head -c 200`)
    console.log(r.stdoutText)

    console.log('\n=== basename ===')
    r = await ws.shell(`basename "${path}"`)
    console.log(r.stdoutText)

    console.log('=== dirname ===')
    r = await ws.shell(`dirname "${path}"`)
    console.log(r.stdoutText)

    console.log('=== realpath ===')
    r = await ws.shell(`realpath "${path}"`)
    console.log(r.stdoutText)

    console.log('=== gws docs documents create ===')
    r = await ws.shell("gws docs documents create --json '{\"title\": \"MIRAGE TS Example Doc\"}'")
    const docId = (JSON.parse(r.stdoutText) as { documentId: string }).documentId
    console.log(`Created: ${docId}`)

    console.log('\n=== gws docs documents batchUpdate ===')
    const body = JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: 'Hello from MIRAGE TS!\n' } }],
    })
    const params = JSON.stringify({ documentId: docId })
    r = await ws.shell(`gws docs documents batchUpdate --params '${params}' --json '${body}'`)
    console.log(`Updated: ${r.stdoutText.slice(0, 80)}`)

    console.log('\n=== gws docs write ===')
    r = await ws.shell(`gws docs write --document ${docId} --text "Appended via gws docs write."`)
    console.log(`Written: ${r.stdoutText.slice(0, 80)}`)

    console.log(`\nOpen: https://docs.google.com/document/d/${docId}/edit`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
