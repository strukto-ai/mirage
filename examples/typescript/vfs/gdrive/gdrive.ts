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
import { GoogleDriveVFS, GWS, MountMode, Workspace, type FileStat, type GDriveConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): GDriveConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

function lines(text: string): string[] {
  return text
    .trim()
    .split('\n')
    .filter((s) => s !== '')
}

async function main(): Promise<void> {
  const config = buildConfig()
  const vfs = new GoogleDriveVFS(config)
  const ws = new Workspace({ '/gdrive': vfs }, { mode: MountMode.WRITE })
  // The gws verbs are a CLI install, separate from the mount.
  ws.registerCli('gws', GWS, { ...config })
  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of [
      'cat /gdrive/__nf_missing__.txt',
      'head /gdrive/__nf_missing__.txt',
      'stat /gdrive/__nf_missing__.txt',
    ]) {
      const res = await ws.shell(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(res.exitCode)}  ${res.stderrText.trim()}`)
    }

    console.log('=== ls /gdrive/ ===')
    let r = await ws.shell('ls /gdrive/')
    console.log(r.stdoutText)

    const entries = lines(r.stdoutText)
    if (entries.length === 0) {
      console.log('No files')
      return
    }
    const first = entries[0]!

    console.log(`=== stat /gdrive/${first} ===`)
    r = await ws.shell(`stat "/gdrive/${first}"`)
    console.log(r.stdoutText)

    // chmod/chown/touch never hit the Drive API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on /gdrive/${first} ===`)
    r = await ws.shell(
      `chmod 640 "/gdrive/${first}" && chown 500:dev "/gdrive/${first}" && touch -t 202601021530 "/gdrive/${first}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(r.exitCode)}`)
    const st = (await ws.dispatch('stat', `/gdrive/${first}`)) as FileStat
    const mode = st.mode !== null ? st.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${mode} uid=${String(st.uid)} gid=${String(st.gid)} mtime=${String(st.modified)}`,
    )

    if (first.endsWith('/')) {
      console.log(`=== ls /gdrive/${first} ===`)
      r = await ws.shell(`ls "/gdrive/${first}"`)
      console.log(r.stdoutText)
      const sub = lines(r.stdoutText)[0]
      if (sub !== undefined && !sub.endsWith('/')) {
        console.log(`=== cat /gdrive/${first}${sub} ===`)
        r = await ws.shell(`cat "/gdrive/${first}${sub}"`)
        console.log(r.stdoutText.slice(0, 500))
      }
    }

    console.log('=== tree -L 1 /gdrive/ ===')
    r = await ws.shell('tree -L 1 /gdrive/')
    console.log(r.stdoutText)

    console.log("=== find /gdrive/ -name '*.gdoc.json' | head -n 5 ===")
    r = await ws.shell("find /gdrive/ -name '*.gdoc.json' | head -n 5")
    console.log(r.stdoutText)

    const gdoc = lines(r.stdoutText)[0]
    if (gdoc !== undefined) {
      console.log(`=== cat ${gdoc} | jq .title ===`)
      r = await ws.shell(`cat "${gdoc}" | jq ".title"`)
      console.log(r.stdoutText)

      console.log(`=== head -n 3 ${gdoc} ===`)
      r = await ws.shell(`head -n 3 "${gdoc}"`)
      console.log(r.stdoutText)

      console.log(`=== head -c 150 ${gdoc} ===`)
      r = await ws.shell(`head -c 150 "${gdoc}"`)
      console.log(r.stdoutText)

      console.log(`=== wc ${gdoc} ===`)
      r = await ws.shell(`wc "${gdoc}"`)
      console.log(r.stdoutText)

      console.log(`=== basename ${gdoc} ===`)
      r = await ws.shell(`basename "${gdoc}"`)
      console.log(r.stdoutText)

      console.log(`=== dirname ${gdoc} ===`)
      r = await ws.shell(`dirname "${gdoc}"`)
      console.log(r.stdoutText)

      console.log(`=== tail -n 3 ${gdoc} ===`)
      r = await ws.shell(`tail -n 3 "${gdoc}"`)
      console.log(r.stdoutText)

      console.log(`=== nl ${gdoc} ===`)
      r = await ws.shell(`nl "${gdoc}"`)
      console.log(r.stdoutText.slice(0, 300))

      console.log(`=== grep title ${gdoc} ===`)
      r = await ws.shell(`grep title "${gdoc}"`)
      console.log(r.stdoutText.slice(0, 300))

      console.log(`=== rg title ${gdoc} ===`)
      r = await ws.shell(`rg title "${gdoc}"`)
      console.log(r.stdoutText.slice(0, 300))

      console.log(`=== cut -c 1-40 ${gdoc} ===`)
      r = await ws.shell(`cut -c 1-40 "${gdoc}"`)
      console.log(r.stdoutText.slice(0, 300))

      console.log(`=== sed -n 2p ${gdoc} ===`)
      r = await ws.shell(`sed -n 2p "${gdoc}"`)
      console.log(r.stdoutText.slice(0, 300))

      console.log(`=== sed s/title/TITLE/g ${gdoc} ===`)
      r = await ws.shell(`sed "s/title/TITLE/g" "${gdoc}"`)
      console.log(r.stdoutText.slice(0, 300))

      console.log(`=== realpath ${gdoc} ===`)
      r = await ws.shell(`realpath "${gdoc}"`)
      console.log(r.stdoutText)
    }

    // Slides and Sheets render to their own JSON shapes in the same tree.
    const gslide = entries.find((e) => e.endsWith('.gslide.json'))
    if (gslide !== undefined) {
      console.log(`=== jq .title /gdrive/${gslide} ===`)
      r = await ws.shell(`jq ".title" "/gdrive/${gslide}"`)
      console.log(r.stdoutText)

      console.log(`=== jq '.slides | length' /gdrive/${gslide} ===`)
      r = await ws.shell(`jq ".slides | length" "/gdrive/${gslide}"`)
      console.log(r.stdoutText)
    }

    const gsheet = entries.find((e) => e.endsWith('.gsheet.json'))
    if (gsheet !== undefined) {
      console.log(`=== jq .properties.title /gdrive/${gsheet} ===`)
      r = await ws.shell(`jq ".properties.title" "/gdrive/${gsheet}"`)
      console.log(r.stdoutText)
    }

    console.log('=== gws docs documents create ===')
    r = await ws.shell(
      "gws docs documents create --json '{\"title\": \"Test from MIRAGE TS gdrive\"}'",
    )
    console.log(r.stdoutText.slice(0, 300))

    console.log('=== gws sheets spreadsheets create ===')
    r = await ws.shell(
      "gws sheets spreadsheets create --json '{\"properties\": {\"title\": \"Test Sheet from TS gdrive\"}}'",
    )
    console.log(r.stdoutText.slice(0, 300))
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
