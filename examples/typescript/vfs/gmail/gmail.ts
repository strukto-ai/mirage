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
import { GWS, GmailVFS, MountMode, Workspace, type FileStat, type GmailConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

function buildConfig(): GmailConfig {
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
  const vfs = new GmailVFS(config)
  const ws = new Workspace({ '/gmail': vfs }, { mode: MountMode.WRITE })
  // The gws verbs are a CLI install, separate from the mount.
  ws.registerCli('gws', GWS, { ...config })

  try {
    console.log('=== not-found errors show the full virtual path ===')
    for (const cmd of [
      'cat /gmail/__nf_missing__.txt',
      'head /gmail/__nf_missing__.txt',
      'stat /gmail/__nf_missing__.txt',
    ]) {
      const res = await ws.shell(cmd)
      console.log(`$ ${cmd}`)
      console.log(`  exit=${String(res.exitCode)}  ${res.stderrText.trim()}`)
    }

    // ls root labels
    console.log('=== ls /gmail/ ===')
    let r = await ws.shell('ls /gmail/')
    console.log(r.stdoutText)

    // Pick INBOX
    const labels = lines(r.stdoutText)
    let label = 'INBOX'
    if (!labels.some((lb) => lb.includes('INBOX'))) label = labels[0] ?? ''
    if (label === '') {
      console.log('No labels')
      return
    }

    // ls label (date directories)
    console.log(`=== ls /gmail/${label}/ ===`)
    r = await ws.shell(`ls /gmail/${label}/`)
    console.log(r.stdoutText)

    const dates = lines(r.stdoutText)
    if (dates.length === 0) {
      console.log('No dates')
      return
    }
    const firstDate = dates[0]!

    // ls date dir (messages)
    console.log(`=== ls /gmail/${label}/${firstDate}/ ===`)
    r = await ws.shell(`ls /gmail/${label}/${firstDate}/`)
    console.log(r.stdoutText)

    const messages = lines(r.stdoutText).filter((m) => m.endsWith('.gmail.json'))
    if (messages.length === 0) {
      console.log('No messages')
      return
    }
    const firstMsg = messages[0]!
    const msgPath = `/gmail/${label}/${firstDate}/${firstMsg}`

    // cat message
    console.log(`=== cat ${msgPath} ===`)
    r = await ws.shell(`cat ${msgPath}`)
    console.log(r.stdoutText.slice(0, 500))

    // head
    console.log('=== head -n 5 ===')
    r = await ws.shell(`head -n 5 ${msgPath}`)
    console.log(r.stdoutText)

    // tail
    console.log('=== tail -n 3 ===')
    r = await ws.shell(`tail -n 3 ${msgPath}`)
    console.log(r.stdoutText)

    // wc
    console.log('=== wc -l ===')
    r = await ws.shell(`wc -l ${msgPath}`)
    console.log(r.stdoutText)

    // stat
    console.log('=== stat ===')
    r = await ws.shell(`stat ${msgPath}`)
    console.log(r.stdoutText)

    // chmod/chown/touch never hit the Gmail API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${msgPath} ===`)
    r = await ws.shell(
      `chmod 640 "${msgPath}" && chown 500:dev "${msgPath}" && touch -t 202601021530 "${msgPath}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(r.exitCode)}`)
    const st = (await ws.dispatch('stat', msgPath)) as FileStat
    const mode = st.mode !== null ? st.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${mode} uid=${String(st.uid)} gid=${String(st.gid)} mtime=${String(st.modified)}`,
    )

    // jq
    console.log('=== jq .subject ===')
    r = await ws.shell(`jq ".subject" ${msgPath}`)
    console.log(r.stdoutText)

    console.log('=== jq .from ===')
    r = await ws.shell(`jq ".from" ${msgPath}`)
    console.log(r.stdoutText)

    // nl
    console.log('=== nl ===')
    r = await ws.shell(`nl ${msgPath}`)
    console.log(r.stdoutText.slice(0, 300))

    // tree
    console.log('=== tree -L 1 /gmail/ ===')
    r = await ws.shell('tree -L 1 /gmail/')
    console.log(r.stdoutText)

    console.log(`=== tree -L 1 /gmail/${label}/ ===`)
    r = await ws.shell(`tree -L 1 /gmail/${label}/`)
    console.log(r.stdoutText)

    // find
    console.log("=== find -name '*.gmail.json' ===")
    r = await ws.shell(`find /gmail/${label}/${firstDate}/ -name "*.gmail.json" | head -n 5`)
    console.log(r.stdoutText)

    // grep
    console.log('=== grep subject ===')
    r = await ws.shell(`grep subject ${msgPath}`)
    console.log(r.stdoutText)

    // rg
    console.log('=== rg subject ===')
    r = await ws.shell(`rg subject ${msgPath}`)
    console.log(r.stdoutText)

    // ── native search dispatch (Gmail q= API) ────────
    for (const [header, cmd] of [
      [
        `grep harbor /gmail/${label}/${firstDate}/*.gmail.json (date scope)`,
        `grep harbor /gmail/${label}/${firstDate}/*.gmail.json`,
      ],
      [`grep harbor /gmail/${label}/ (label scope)`, `grep harbor /gmail/${label}/`],
      ['grep harbor /gmail/ (mailbox scope)', 'grep harbor /gmail/'],
      ['rg harbor /gmail/', 'rg harbor /gmail/'],
    ] as const) {
      console.log(`\n=== ${header} ===`)
      r = await ws.shell(cmd)
      const found = lines(r.stdoutText)
      console.log(`  exit=${String(r.exitCode)} matches: ${String(found.length)}`)
      for (const line of found.slice(0, 3)) console.log(`  ${line.slice(0, 150)}`)
    }

    // basename
    console.log('=== basename ===')
    r = await ws.shell(`basename ${msgPath}`)
    console.log(r.stdoutText)

    // dirname
    console.log('=== dirname ===')
    r = await ws.shell(`dirname ${msgPath}`)
    console.log(r.stdoutText)

    // realpath
    console.log('=== realpath ===')
    r = await ws.shell(`realpath ${msgPath}`)
    console.log(r.stdoutText)

    // VFS-specific commands

    // gws gmail triage
    console.log('=== gws gmail triage ===')
    r = await ws.shell('gws gmail triage --query "is:unread" --max 3')
    console.log(r.stdoutText.slice(0, 500))

    // ── glob expansion (exercises resolve_glob → readdir)
    console.log('=== echo glob: *.gmail.json ===')
    r = await ws.shell(`echo /gmail/${label}/${firstDate}/*.gmail.json`)
    const globbed = r.stdoutText.trim()
    console.log(`  ${globbed.slice(0, 200)}`)
    if (globbed === '') throw new Error('glob should match at least one file')

    console.log('=== for f in *.gmail.json (glob loop) ===')
    r = await ws.shell(
      `for f in /gmail/${label}/${firstDate}/*.gmail.json; do echo found:$f; done | head -n 3`,
    )
    for (const line of lines(r.stdoutText)) console.log(`  ${line.slice(0, 120)}`)

    // gws gmail read (use message_id from filename)
    const msgId = (firstMsg.split('__').pop() ?? '').replace('.gmail.json', '')
    console.log(`=== gws gmail read --id ${msgId} ===`)
    r = await ws.shell(`gws gmail read --id ${msgId}`)
    console.log(r.stdoutText.slice(0, 500))

    // gws gmail send
    console.log('=== gws gmail send ===')
    r = await ws.shell(
      'gws gmail send --to "zechengzhang97@gmail.com" --subject "Test from MIRAGE TS" --body "Sent by gmail.ts example"',
    )
    const sendOut = r.stdoutText
    console.log(sendOut.slice(0, 200))

    let sentId = ''
    if (sendOut.trim() !== '') {
      sentId = (JSON.parse(sendOut) as { id?: string }).id ?? ''
    }

    // gws gmail reply
    if (sentId !== '') {
      console.log('=== gws gmail reply ===')
      r = await ws.shell(`gws gmail reply --message-id ${sentId} --body "Reply from MIRAGE TS"`)
      console.log(r.stdoutText.slice(0, 200))
    }

    // gws gmail reply-all
    if (sentId !== '') {
      console.log('=== gws gmail reply-all ===')
      r = await ws.shell(`gws gmail reply-all --message-id ${sentId} --body "Reply-all from MIRAGE TS"`)
      console.log(r.stdoutText.slice(0, 200))
    }

    // gws gmail forward
    if (sentId !== '') {
      console.log('=== gws gmail forward ===')
      r = await ws.shell(`gws gmail forward --message-id ${sentId} --to "zechengzhang97@gmail.com"`)
      console.log(r.stdoutText.slice(0, 200))
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
