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
import { GmailVFS, MountMode, Workspace, type GmailConfig } from '@struktoai/mirage-node'

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

// Python's shlex.quote, so the printed commands match the Python example.
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function show(ws: Workspace, cmd: string): Promise<string> {
  console.log(`\n$ ${cmd}`)
  const r = await ws.shell(cmd)
  if (r.stdoutText !== '') console.log(`STDOUT:\n${r.stdoutText}`)
  if (r.stderrText !== '') console.log(`STDERR:\n${r.stderrText}`)
  console.log(`exit=${String(r.exitCode)}`)
  return r.stdoutText
}

async function main(): Promise<void> {
  const ws = new Workspace({ '/gmail': new GmailVFS(buildConfig()) }, { mode: MountMode.READ })
  try {
    const dates = lines(await show(ws, 'ls /gmail/INBOX/ | head -5'))
    if (dates.length === 0) {
      console.log('(no dates in INBOX)')
      return
    }
    const firstDate = dates[0]!

    // A date dir lists message files (*.gmail.json); a message that has
    // attachments also gets a sibling folder named after the message.
    const entries = lines(await show(ws, `ls ${shellQuote(`/gmail/INBOX/${firstDate}`)}`))
    const msgFile = entries.find((e) => e.endsWith('.gmail.json'))
    if (msgFile === undefined) {
      throw new Error(`date dir should contain a *.gmail.json msg: ${JSON.stringify(entries)}`)
    }

    await show(
      ws,
      `cat ${shellQuote(`/gmail/INBOX/${firstDate}/${msgFile}`)} ` +
        "| jq '{subject, from: .from.email, attachments: [.attachments[].filename]}'",
    )

    // Find a message with attachments: a date-dir entry without the
    // .gmail.json suffix is the attachment folder for the matching message,
    // so "<name>.gmail.json" is its message file.
    console.log('\n=== finding a message with attachments ===')
    for (const d of dates) {
      const r = await ws.shell(`ls ${shellQuote(`/gmail/INBOX/${d}`)}`)
      const attDir = lines(r.stdoutText).find((e) => !e.endsWith('.gmail.json'))
      if (attDir !== undefined) {
        console.log(`FOUND: /gmail/INBOX/${d}/${attDir}`)
        await show(ws, `ls ${shellQuote(`/gmail/INBOX/${d}/${attDir}`)}`)
        await show(
          ws,
          `cat ${shellQuote(`/gmail/INBOX/${d}/${attDir}.gmail.json`)} | jq '.attachments'`,
        )
        return
      }
    }
    console.log('(no attachments found in scanned dates)')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
