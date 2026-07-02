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
import { GmailResource, MountMode, Workspace, type FileStat, type GmailConfig } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): GmailConfig {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are required')
  }
  return { clientId, clientSecret, refreshToken }
}

async function run(
  ws: Workspace,
  cmd: string,
): Promise<{ out: string; err: string; code: number }> {
  try {
    const r = await ws.execute(cmd)
    return { out: r.stdoutText, err: r.stderrText, code: r.exitCode }
  } catch (err) {
    return { out: '', err: err instanceof Error ? err.message : String(err), code: 1 }
  }
}

function printSection(label: string, out: string, err: string, max = 500): void {
  console.log(`=== ${label} ===`)
  if (out !== '') console.log(out.length > max ? out.slice(0, max) + '...' : out)
  if (err !== '') process.stderr.write(`  STDERR: ${err.trim().slice(0, 200)}\n`)
}

async function main(): Promise<void> {
  const resource = new GmailResource(buildConfig())
  const ws = new Workspace({ '/gmail': resource }, { mode: MountMode.WRITE })

  try {
    const lsRoot = await run(ws, 'ls /gmail/')
    printSection('ls /gmail/', lsRoot.out, lsRoot.err)

    const labels = lsRoot.out
      .trim()
      .split('\n')
      .filter((s) => s !== '')
    let label = 'INBOX'
    if (!labels.some((lb) => lb.includes('INBOX'))) {
      label = labels[0] ?? ''
    }
    if (label === '') {
      console.log('No labels')
      return
    }

    const lsLabel = await run(ws, `ls /gmail/${label}/`)
    printSection(`ls /gmail/${label}/`, lsLabel.out, lsLabel.err)

    const dates = lsLabel.out
      .trim()
      .split('\n')
      .filter((s) => s !== '')
    if (dates.length === 0) {
      console.log('No dates')
      return
    }
    const firstDate = dates[0] ?? ''

    const lsDate = await run(ws, `ls /gmail/${label}/${firstDate}/`)
    printSection(`ls /gmail/${label}/${firstDate}/`, lsDate.out, lsDate.err)

    const messages = lsDate.out
      .trim()
      .split('\n')
      .filter((s) => s.endsWith('.gmail.json'))
    if (messages.length === 0) {
      console.log('No messages')
      return
    }
    const firstMsg = messages[0] ?? ''
    const msgPath = `/gmail/${label}/${firstDate}/${firstMsg}`

    printSection(`cat ${msgPath}`, (await run(ws, `cat ${msgPath}`)).out, '')
    printSection('head -n 5', (await run(ws, `head -n 5 ${msgPath}`)).out, '')
    printSection('tail -n 3', (await run(ws, `tail -n 3 ${msgPath}`)).out, '')
    printSection('wc -l', (await run(ws, `wc -l ${msgPath}`)).out, '')
    printSection('stat', (await run(ws, `stat ${msgPath}`)).out, '')


    // chmod/chown/touch never hit the Gmail API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${msgPath} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "${msgPath}" && chown 500:dev "${msgPath}" && touch -t 202601021530 "${msgPath}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', `${msgPath}`)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )
    printSection('jq .subject', (await run(ws, `jq ".subject" ${msgPath}`)).out, '')
    printSection('jq .from', (await run(ws, `jq ".from" ${msgPath}`)).out, '')
    printSection('nl', (await run(ws, `nl ${msgPath}`)).out, '', 300)
    printSection('tree -L 1 /gmail/', (await run(ws, 'tree -L 1 /gmail/')).out, '')
    printSection(
      `tree -L 1 /gmail/${label}/`,
      (await run(ws, `tree -L 1 /gmail/${label}/`)).out,
      '',
    )

    const findOut = await run(
      ws,
      `find /gmail/${label}/${firstDate}/ -name "*.gmail.json" | head -n 5`,
    )
    printSection("find -name '*.gmail.json'", findOut.out, findOut.err)

    printSection('grep subject', (await run(ws, `grep subject ${msgPath}`)).out, '')
    printSection('rg subject', (await run(ws, `rg subject ${msgPath}`)).out, '')

    console.log(
      `\n=== grep harbor /gmail/${label}/${firstDate}/*.gmail.json (date scope) ===`,
    )
    const dateScope = await run(ws, `grep harbor /gmail/${label}/${firstDate}/*.gmail.json`)
    const dateLines = dateScope.out.trim().split('\n').filter((s) => s !== '')
    console.log(`  exit=${String(dateScope.code)} matches: ${String(dateLines.length)}`)
    for (const line of dateLines.slice(0, 3)) console.log(`  ${line.slice(0, 150)}`)

    console.log(`\n=== grep harbor /gmail/${label}/ (label scope) ===`)
    const labelScope = await run(ws, `grep harbor /gmail/${label}/`)
    const labelLines = labelScope.out.trim().split('\n').filter((s) => s !== '')
    console.log(`  exit=${String(labelScope.code)} matches: ${String(labelLines.length)}`)
    for (const line of labelLines.slice(0, 3)) console.log(`  ${line.slice(0, 150)}`)

    console.log('\n=== grep harbor /gmail/ (mailbox scope) ===')
    const mailboxScope = await run(ws, 'grep harbor /gmail/')
    const mboxLines = mailboxScope.out.trim().split('\n').filter((s) => s !== '')
    console.log(`  exit=${String(mailboxScope.code)} matches: ${String(mboxLines.length)}`)
    for (const line of mboxLines.slice(0, 3)) console.log(`  ${line.slice(0, 150)}`)

    console.log('\n=== rg harbor /gmail/ ===')
    const rgScope = await run(ws, 'rg harbor /gmail/')
    const rgLines = rgScope.out.trim().split('\n').filter((s) => s !== '')
    console.log(`  exit=${String(rgScope.code)} matches: ${String(rgLines.length)}`)
    for (const line of rgLines.slice(0, 3)) console.log(`  ${line.slice(0, 150)}`)

    printSection('basename', (await run(ws, `basename ${msgPath}`)).out, '')
    printSection('dirname', (await run(ws, `dirname ${msgPath}`)).out, '')
    printSection('realpath', (await run(ws, `realpath ${msgPath}`)).out, '')

    printSection(
      'gws-gmail-triage',
      (await run(ws, 'gws-gmail-triage --query "is:unread" --max 3')).out,
      '',
    )

    const echoGlob = await run(ws, `echo /gmail/${label}/${firstDate}/*.gmail.json`)
    console.log('=== echo glob: *.gmail.json ===')
    console.log(`  ${echoGlob.out.trim().slice(0, 200)}`)

    const loopGlob = await run(
      ws,
      `for f in /gmail/${label}/${firstDate}/*.gmail.json; do echo found:$f; done | head -n 3`,
    )
    console.log('=== for f in *.gmail.json (glob loop) ===')
    for (const line of loopGlob.out.trim().split('\n')) console.log(`  ${line.slice(0, 120)}`)

    const msgId = (firstMsg.split('__').pop() ?? '').replace('.gmail.json', '')
    printSection(
      `gws-gmail-read --id ${msgId}`,
      (await run(ws, `gws-gmail-read --id ${msgId}`)).out,
      '',
    )

    const sendOut = await run(
      ws,
      'gws-gmail-send --to "zechengzhang97@gmail.com" --subject "Test from MIRAGE TS" --body "Sent by gmail.ts example"',
    )
    printSection('gws-gmail-send', sendOut.out, sendOut.err, 200)

    let sentId = ''
    if (sendOut.out.trim() !== '') {
      try {
        const sent = JSON.parse(sendOut.out) as { id?: string }
        sentId = sent.id ?? ''
      } catch {
        // ignore — JSON parse failure leaves sentId empty
      }
    }

    if (sentId !== '') {
      printSection(
        'gws-gmail-reply',
        (
          await run(
            ws,
            `gws-gmail-reply --message-id ${sentId} --body "Reply from MIRAGE TS"`,
          )
        ).out,
        '',
        200,
      )
      printSection(
        'gws-gmail-reply-all',
        (
          await run(
            ws,
            `gws-gmail-reply-all --message-id ${sentId} --body "Reply-all from MIRAGE TS"`,
          )
        ).out,
        '',
        200,
      )
      printSection(
        'gws-gmail-forward',
        (
          await run(
            ws,
            `gws-gmail-forward --message-id ${sentId} --to "zechengzhang97@gmail.com"`,
          )
        ).out,
        '',
        200,
      )
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
