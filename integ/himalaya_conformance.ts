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

// Conformance gate for the virtualized `himalaya` CLI, the twin of
// ntn_conformance.ts. Every case in integ/cli/himalaya.json runs twice: the
// shared battery runs it inside a mirage workspace, and this runs the SAME line
// in a real shell with the real `himalaya` binary (pinned by HIMALAYA_VERSION)
// pointed at the same fake mail server. A golden both agree on is by
// construction what the upstream program prints.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { start } from './server/kit/typescript/index.ts'
import { startMailArms } from './server/mail/arms.ts'
import { mailFake } from './server/mail/fake.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BATTERY = join(HERE, 'cli', 'himalaya.json')
const HIMALAYA_VERSION = '2.2.1'
const RUN = 'conformance1'
const ACCOUNTS = ['integ', 'alpha', 'beta']
const SHIMS: Record<string, string> = { himalaya: 'integ', h1: 'alpha', h2: 'beta' }

interface Expect {
  exit: number
  stdout: string
  stderr: string
}

interface Case {
  id: string
  seq: number
  command: string
  expect: Expect
  conformance_skip?: string
}

interface Run {
  exit: number
  stdout: string
  stderr: string
}

// A line that names a mount path exercises the VFS, and a help page describes
// a tree that is deliberately a subset of upstream's.
function isConformable(one: Case): boolean {
  if (one.conformance_skip !== undefined) return false
  return !/\/mail\b|--help/.test(one.command)
}

function resolveBinary(): string | null {
  const pinned = process.env.HIMALAYA_BIN
  if (pinned !== undefined && pinned !== '') return pinned
  const found = spawnSync('which', ['himalaya'], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : null
}

function configToml(imapPort: string, smtpPort: string): string {
  return ACCOUNTS.map(
    (account, index) => `[accounts.${account}]
email = "${account}@example.com"
${index === 0 ? 'default = true' : ''}
imap.server = "imap://127.0.0.1:${imapPort}"
imap.starttls = false
imap.sasl.plain.username = "${account}@example.com"
imap.sasl.plain.password.raw = "${RUN}"
smtp.server = "smtp://127.0.0.1:${smtpPort}"
smtp.starttls = false
smtp.sasl.plain.username = "${account}@example.com"
smtp.sasl.plain.password.raw = "${RUN}"
mailbox.alias.trash = "Trash"
message.send.save-copy = "Sent"
`,
  ).join('\n')
}

function portOf(url: string): string {
  return url.slice(url.lastIndexOf(':') + 1)
}

// Async on purpose: the fake is served by this process's event loop, so a
// synchronous spawn would block the very loop that answers the child.
function runLine(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { env, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ exit: code ?? -1, stdout, stderr })
    })
    child.stdin.end()
  })
}

async function main(): Promise<void> {
  const binary = resolveBinary()
  if (binary === null) {
    console.error('himalaya conformance: no `himalaya` binary on PATH and HIMALAYA_BIN unset.')
    process.exit(1)
  }
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).split('\n')[0] ?? ''
  if (!version.includes(`v${HIMALAYA_VERSION}`)) {
    console.error(`himalaya conformance: expected v${HIMALAYA_VERSION}, found "${version}"`)
    process.exit(1)
  }

  const battery = JSON.parse(readFileSync(BATTERY, 'utf8')) as { cases: Case[] }
  const cases = [...battery.cases].sort((a, b) => a.seq - b.seq)

  const http = await start(mailFake, 0)
  const arms = await startMailArms(http.runtime, 0, 0)
  const imapUrl = arms.announces.find((one) => one.token === 'MAIL_IMAP_URL')?.url ?? ''
  const smtpUrl = arms.announces.find((one) => one.token === 'MAIL_SMTP_URL')?.url ?? ''

  const home = mkdtempSync(join(tmpdir(), 'himalaya-conformance-'))
  const shims = join(home, 'bin')
  const scratch = join(home, 'scratch')
  mkdirSync(shims)
  mkdirSync(scratch)
  const config = join(home, 'config.toml')
  writeFileSync(config, configToml(portOf(imapUrl), portOf(smtpUrl)))
  for (const [name, account] of Object.entries(SHIMS)) {
    const path = join(shims, name)
    writeFileSync(path, `#!/bin/sh\nexec "${binary}" -c "${config}" -a ${account} "$@"\n`)
    chmodSync(path, 0o755)
  }
  const reset = await fetch(`http://127.0.0.1:${String(http.port)}/_run/${RUN}/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tenants: ACCOUNTS, extras: { manifest: 'v1' } }),
  })
  if (!reset.ok) throw new Error(`reset failed: ${String(reset.status)}`)

  const env = {
    ...process.env,
    PATH: `${shims}:${process.env.PATH ?? ''}`,
    HOME: home,
    NO_COLOR: '1',
  }
  const skipped: string[] = []
  const failures: string[] = []
  let checked = 0
  for (const one of cases) {
    if (!isConformable(one)) {
      skipped.push(
        one.conformance_skip === undefined ? one.id : `${one.id} (${one.conformance_skip})`,
      )
      continue
    }
    checked += 1
    const got = await runLine(one.command.replaceAll('/scratch', scratch), env, home)
    const out = got.stdout.replaceAll(home, '')
    const err = got.stderr.replaceAll(home, '')
    const diffs: string[] = []
    if (got.exit !== one.expect.exit) {
      diffs.push(`  exit: want ${String(one.expect.exit)}, got ${String(got.exit)}`)
    }
    if (out !== one.expect.stdout) {
      diffs.push(
        `  stdout want: ${JSON.stringify(one.expect.stdout)}\n  stdout got : ${JSON.stringify(out)}`,
      )
    }
    if (err !== one.expect.stderr) {
      diffs.push(
        `  stderr want: ${JSON.stringify(one.expect.stderr)}\n  stderr got : ${JSON.stringify(err)}`,
      )
    }
    if (diffs.length > 0) failures.push(`${one.id} (${one.command})\n${diffs.join('\n')}`)
  }

  await arms.close()
  await http.close()
  rmSync(home, { recursive: true, force: true })

  console.log(`${version}: ${String(checked)} checked, ${String(skipped.length)} not comparable`)
  for (const one of skipped) console.log(`  skipped: ${one}`)
  if (failures.length > 0) {
    console.error(`\n${String(failures.length)} divergence(s) from the real CLI:\n`)
    for (const one of failures) console.error(`${one}\n`)
    process.exit(1)
  }
  console.log('all conformable cases match the real CLI')
}

await main()
