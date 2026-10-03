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

import { spawn } from 'node:child_process'
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import { headerJson } from './wire.ts'

// The dropbox fake's read wire. mirage stamps a read with the content_hash
// a download's Dropbox-API-Result names and compares it with the hash stat
// takes from a list_folder row, so a fake that dropped the header, or sent
// it on a full read only, would let every `read: fresh` case pass by
// refetching each time. Wire-level on purpose: no mirage client in between.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-dropbox'
const PATH = '/d/é.txt'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`dropbox selftest failed: ${name} ${detail}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
}

async function launch(): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const first = await new Promise<string>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl !== -1) ok(out.slice(0, nl))
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  check('announce line matches ANNOUNCE_RE', ANNOUNCE_RE.test(first), first)
  return { child, endpoint: first.split('=').slice(1).join('=') }
}

const AUTH = { Authorization: `Bearer ${TENANT}` }

async function upload(endpoint: string, body: string): Promise<void> {
  const r = await fetch(`${endpoint}/2/files/upload`, {
    method: 'POST',
    headers: {
      ...AUTH,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': headerJson({ path: PATH }),
    },
    body,
  })
  check(`upload ${JSON.stringify(body)} is 200`, r.status === 200, String(r.status))
  await r.arrayBuffer()
}

async function rowHash(endpoint: string): Promise<string> {
  const r = await fetch(`${endpoint}/2/files/list_folder`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/d' }),
  })
  const listing = (await r.json()) as { entries?: Record<string, unknown>[] }
  const row = (listing.entries ?? []).find((e) => e.name === 'é.txt') ?? {}
  const hash = typeof row.content_hash === 'string' ? row.content_hash : ''
  check('the list_folder row carries a content_hash', r.status === 200 && hash !== '', hash)
  return hash
}

async function download(endpoint: string, range?: string): Promise<Response> {
  return fetch(`${endpoint}/2/files/download`, {
    method: 'POST',
    headers: {
      ...AUTH,
      'Dropbox-API-Arg': headerJson({ path: PATH }),
      ...(range ? { Range: range } : {}),
    },
  })
}

function resultHash(r: Response): string | null {
  const raw = r.headers.get('Dropbox-API-Result')
  if (raw === null) return null
  const result = JSON.parse(raw) as { content_hash?: unknown }
  return typeof result.content_hash === 'string' ? result.content_hash : null
}

async function main(): Promise<void> {
  const fake = await launch()
  try {
    const reset = await fetch(`${fake.endpoint}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT] }),
    })
    check('/reset creates the tenant', reset.status === 200, String(reset.status))
    await reset.arrayBuffer()

    await upload(fake.endpoint, '0123456789')
    const hash = await rowHash(fake.endpoint)

    const whole = await download(fake.endpoint)
    check(
      'a whole download names the row content_hash in Dropbox-API-Result',
      whole.status === 200 && resultHash(whole) === hash,
      `${String(whole.status)} ${String(resultHash(whole))}`,
    )
    check('the whole download is the file', (await whole.text()) === '0123456789')

    const ranged = await download(fake.endpoint, 'bytes=2-4')
    check(
      'a ranged (206) download names the same content_hash',
      ranged.status === 206 && resultHash(ranged) === hash,
      `${String(ranged.status)} ${String(resultHash(ranged))}`,
    )
    check('the ranged download is the window', (await ranged.text()) === '234')

    const past = await download(fake.endpoint, 'bytes=10-19')
    check(
      'a window starting at EOF is 416 with no Dropbox-API-Result',
      past.status === 416 && past.headers.get('Dropbox-API-Result') === null,
      `${String(past.status)} ${String(past.headers.get('Dropbox-API-Result'))}`,
    )
    await past.arrayBuffer()

    await upload(fake.endpoint, '9876543210')
    const next = await rowHash(fake.endpoint)
    check('a same-size rewrite moves the row content_hash', next !== hash, `${hash} -> ${next}`)
    const after = await download(fake.endpoint, 'bytes=0-0')
    check(
      'the download after the rewrite names the new content_hash',
      after.status === 206 && resultHash(after) === next,
      `${String(after.status)} ${String(resultHash(after))}`,
    )
    await after.arrayBuffer()

    process.stdout.write(`dropbox selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
