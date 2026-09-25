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
import { HfBucketsVFS } from '@struktoai/mirage-node'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'

// mirage reads a bucket file over paths-info and resolve rather than through
// opendal, and stamps the download's ETag as the token stat reports. Every
// shape pinned here was measured against huggingface.co on 2026-09-25; a fake
// that drifted from one would let the battery pass against a Hub that does not
// exist (a missing ETag, for one, passes every consistency case by refetching).

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-hf'
const BUCKET = `${TENANT}/b`

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`hf selftest failed: ${name} ${detail}`)
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

async function pathsInfo(endpoint: string, paths: string[]): Promise<Record<string, unknown>[]> {
  const r = await fetch(`${endpoint}/api/buckets/${BUCKET}/paths-info`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  })
  check(`paths-info ${JSON.stringify(paths)} is 200`, r.status === 200, String(r.status))
  return (await r.json()) as Record<string, unknown>[]
}

function resolveUrl(endpoint: string, path: string): string {
  return `${endpoint}/buckets/${BUCKET}/resolve/${path}`
}

async function main(): Promise<void> {
  const fake = await launch()
  try {
    const reset = await fetch(`${fake.endpoint}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('/reset seeds the empty fixture', reset.status === 200, String(reset.status))

    // Content arrives the way the battery's does: written through opendal,
    // over the fake's Xet upload path.
    const vfs = new HfBucketsVFS({ bucket: BUCKET, token: TENANT, endpoint: fake.endpoint })
    const op = await vfs.accessor.operator()
    await op.write('a.txt', Buffer.from('abc'))
    await op.write('d/x.txt', Buffer.from('x'))

    const rows = await pathsInfo(fake.endpoint, ['a.txt', '/a.txt', 'd', 'd/'])
    check('only the exact file path answers a row', rows.length === 1, JSON.stringify(rows))
    const row = rows[0] ?? {}
    const hash = String(row.xetHash ?? '')
    check(
      'the row is the asked file, with a xet hash',
      row.path === 'a.txt' && row.type === 'file' && hash !== '',
      hash,
    )

    const whole = await fetch(resolveUrl(fake.endpoint, 'a.txt'), { headers: AUTH })
    check(
      'a whole download carries the xet hash as its strong ETag',
      whole.status === 200 && whole.headers.get('etag') === `"${hash}"`,
      `${String(whole.status)} ${String(whole.headers.get('etag'))}`,
    )
    check('the whole download is the file', (await whole.text()) === 'abc')

    const ranged = await fetch(resolveUrl(fake.endpoint, 'a.txt'), {
      headers: { ...AUTH, Range: 'bytes=1-1' },
    })
    check(
      'a ranged download carries the same ETag',
      ranged.status === 206 && ranged.headers.get('etag') === `"${hash}"`,
      `${String(ranged.status)} ${String(ranged.headers.get('etag'))}`,
    )
    await ranged.arrayBuffer()

    const past = await fetch(resolveUrl(fake.endpoint, 'a.txt'), {
      headers: { ...AUTH, Range: 'bytes=3-9' },
    })
    check(
      'a window starting at EOF is 416 with no ETag',
      past.status === 416 && past.headers.get('etag') === null,
      `${String(past.status)} ${String(past.headers.get('etag'))}`,
    )
    await past.arrayBuffer()

    const missing = await fetch(resolveUrl(fake.endpoint, 'nope.txt'), { headers: AUTH })
    check(
      'a missing file is 404 EntryNotFound',
      missing.status === 404 && missing.headers.get('x-error-code') === 'EntryNotFound',
      `${String(missing.status)} ${String(missing.headers.get('x-error-code'))}`,
    )
    await missing.arrayBuffer()
    await vfs.close()

    process.stdout.write(`hf selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
