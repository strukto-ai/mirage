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
  EmailResource,
  MountMode,
  Workspace,
  buildEmailConfig,
  type EmailConfig,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildConfig(): EmailConfig {
  const imapHost = process.env.IMAP_HOST ?? ''
  const smtpHost = process.env.SMTP_HOST ?? ''
  const username = process.env.EMAIL_USERNAME ?? ''
  const password = process.env.EMAIL_PASSWORD ?? ''
  if (imapHost === '' || smtpHost === '' || username === '' || password === '') {
    throw new Error(
      'IMAP_HOST / SMTP_HOST / EMAIL_USERNAME / EMAIL_PASSWORD are required',
    )
  }
  return buildEmailConfig({
    imapHost,
    smtpHost,
    username,
    password,
    maxMessages: 20,
  })
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
  const resource = new EmailResource(buildConfig())
  const ws = new Workspace({ '/email': resource }, { mode: MountMode.READ })

  try {
    const lsRoot = await run(ws, 'ls /email/')
    printSection('ls /email/', lsRoot.out, lsRoot.err)

    const folders = lsRoot.out
      .trim()
      .split('\n')
      .filter((s) => s !== '')
    let folder = 'Inbox'
    if (!folders.some((f) => f.includes('Inbox') || f.includes('INBOX'))) {
      folder = folders[0] ?? ''
    } else {
      folder = folders.find((f) => f.includes('INBOX')) ?? folders.find((f) => f.includes('Inbox')) ?? folder
    }
    if (folder === '') {
      console.log('No folders')
      return
    }

    const lsFolder = await run(ws, `ls /email/${folder}/`)
    printSection(`ls /email/${folder}/`, lsFolder.out, lsFolder.err)

    const dates = lsFolder.out
      .trim()
      .split('\n')
      .filter((s) => s !== '')
    if (dates.length === 0) {
      console.log('No dates')
      return
    }
    const firstDate = dates[0] ?? ''

    const lsDate = await run(ws, `ls /email/${folder}/${firstDate}/`)
    printSection(`ls /email/${folder}/${firstDate}/`, lsDate.out, lsDate.err)

    const messages = lsDate.out
      .trim()
      .split('\n')
      .filter((s) => s.endsWith('.email.json'))
    if (messages.length === 0) {
      console.log('No messages')
      return
    }
    const firstMsg = `/email/${folder}/${firstDate}/${messages[0] ?? ''}`

    printSection(`cat ${firstMsg}`, (await run(ws, `cat ${firstMsg}`)).out, '')
    printSection(`jq .subject ${firstMsg}`, (await run(ws, `jq ".subject" ${firstMsg}`)).out, '')
    printSection(`jq .from ${firstMsg}`, (await run(ws, `jq ".from" ${firstMsg}`)).out, '')

    printSection(
      'email-triage --unseen --max 5',
      (await run(ws, `email-triage --folder ${folder} --unseen --max 5`)).out,
      '',
    )

    printSection(
      `tree -L 2 /email/${folder}/`,
      (await run(ws, `tree -L 2 /email/${folder}/`)).out,
      '',
    )

    for (const [label, cmd] of [
      [
        `grep -r Hi /email/${folder}/ (folder scope, IMAP search)`,
        `grep -r Hi /email/${folder}/`,
      ],
      [`rg Hi /email/${folder}/ (folder scope)`, `rg Hi /email/${folder}/`],
    ] as const) {
      console.log(`\n=== ${label} ===`)
      const r = await run(ws, cmd)
      const lines = r.out.trim() === '' ? [] : r.out.trim().split('\n')
      console.log(`  exit=${String(r.code)} matches: ${String(lines.length)}`)
      if (r.err.trim() !== '') console.log(`  stderr: ${r.err.trim().slice(0, 200)}`)
      for (const line of lines.slice(0, 3)) console.log(`  ${line.slice(0, 150)}`)
    }

    // ── glob expansion: the folder segment is the pattern, the date
    // tail keeps walking (lists folders once, then each match's days).
    const globFolder = `${folder.slice(0, 2)}*`
    console.log(`\n=== echo /email/${globFolder}/2* (mid-path glob) ===`)
    const globR = await run(ws, `echo /email/${globFolder}/2*`)
    console.log(`  ${globR.out.trim().slice(0, 200)}`)
    if (!globR.out.includes(`/email/${folder}/2`)) {
      throw new Error('regression: mid-path glob did not expand')
    }

    // A glob that matches nothing stays the literal word, so the
    // command reports it like GNU coreutils.
    console.log('\n=== cat /email/zz-none-*/x.eml (no match) ===')
    const litR = await run(ws, 'cat /email/zz-none-*/x.eml')
    console.log(`  exit=${String(litR.code)}  ${litR.err.trim().slice(0, 120)}`)
    if (litR.code !== 1 || !litR.err.includes('zz-none-*')) {
      throw new Error('regression: zero-match glob did not keep the literal')
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
