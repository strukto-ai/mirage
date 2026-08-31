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
import type { JsonValue } from '../kit/typescript/types.ts'

// The git plumbing write path, which the corpus does not reach: the gh battery
// exercises the porcelain, and a client that BUILDS history calls
// `POST /git/trees` then `POST /git/commits`. That is the path a fixture uses
// to pin a commit's own author and date, so it is the path that has to hold.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-github'
const REPO = 'integ/repo-v1'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`github selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
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

const HEADERS = {
  'x-mirage-tenant': TENANT,
  authorization: 'token integ',
  'content-type': 'application/json',
}

async function post(url: string, body: JsonValue): Promise<{ status: number; body: JsonValue }> {
  const r = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as JsonValue }
}

async function get(url: string): Promise<JsonValue> {
  const r = await fetch(url, { headers: HEADERS })
  return (await r.json()) as JsonValue
}

function field(body: JsonValue, key: string): JsonValue {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? ((body as Record<string, JsonValue>)[key] ?? null)
    : null
}

// One staged tree holding one file, which is what a commit needs to exist.
async function stage(at: string, path: string, content: string): Promise<string> {
  const tree = await post(`${at}/repos/${REPO}/git/trees`, {
    tree: [{ path, mode: '100644', type: 'blob', content }],
  })
  return String(field(tree.body, 'sha') ?? '')
}

const AUTHOR = { name: 'Dana Wu', email: 'dana@example.com', date: '2025-09-02T09:00:00+08:00' }

async function main(): Promise<void> {
  const fake = await launch()
  const at = fake.endpoint
  try {
    const reset = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('/reset seeds the fixture', reset.status === 200, String(reset.status))

    // ---- an author the caller states is the author the fake keeps
    const t1 = await stage(at, 'tasks/one.md', '# one\n')
    const made = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task one',
      tree: t1,
      author: AUTHOR,
    })
    check('a commit is created', made.status === 201, String(made.status))
    eq('the response echoes the author verbatim', field(made.body, 'author'), AUTHOR)

    // The offset is the point. Normalizing it to UTC would answer the same
    // instant spelled differently, and a fixture that pinned +08:00 would read
    // back as something it did not write.
    const author = field(made.body, 'author')
    check(
      'the pinned offset survives',
      String(field(author, 'date')) === '2025-09-02T09:00:00+08:00',
      String(field(author, 'date')),
    )
    eq('a missing committer defaults to the author', field(made.body, 'committer'), AUTHOR)

    // ---- and it survives the round trip, which is what a reader sees
    const sha = String(field(made.body, 'sha') ?? '')
    const read = await get(`${at}/repos/${REPO}/git/commits/${sha}`)
    eq('GET /git/commits/:sha reports the author', field(read, 'author'), AUTHOR)
    eq('and the committer', field(read, 'committer'), AUTHOR)

    // ---- the list endpoint, which is what "most recent commits" reads
    const listed = await get(`${at}/repos/${REPO}/commits`)
    const top = Array.isArray(listed) ? (listed[0] ?? null) : null
    eq('the commit list carries the author', field(field(top, 'commit'), 'author'), AUTHOR)

    // ---- a committer distinct from the author is kept distinct
    const t2 = await stage(at, 'tasks/two.md', '# two\n')
    const two = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task two',
      tree: t2,
      author: AUTHOR,
      committer: { name: 'Sam Iyer', email: 'sam@example.com', date: '2025-09-03T11:30:00+08:00' },
    })
    eq('a distinct committer is kept', field(two.body, 'committer'), {
      name: 'Sam Iyer',
      email: 'sam@example.com',
      date: '2025-09-03T11:30:00+08:00',
    })
    eq('and does not overwrite the author', field(two.body, 'author'), AUTHOR)

    // ---- an author naming only a date still gets a whole person
    const t3 = await stage(at, 'tasks/three.md', '# three\n')
    const dated = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task three',
      tree: t3,
      author: { date: '2025-09-04T08:00:00Z' },
    })
    eq('a date-only author is filled out', field(dated.body, 'author'), {
      name: 'integ-user',
      email: 'integ-user@users.noreply.github.com',
      date: '2025-09-04T08:00:00Z',
    })

    // ---- a commit that names nobody is unchanged, which is what the goldens
    // record: the author blocks are absent, not empty.
    const t4 = await stage(at, 'tasks/four.md', '# four\n')
    const bare = await post(`${at}/repos/${REPO}/git/commits`, { message: 'Add four', tree: t4 })
    check('a commit naming nobody has no author', field(bare.body, 'author') === null, 'absent')
    check(
      'and no committer',
      field(bare.body, 'committer') === null,
      String(field(bare.body, 'committer')),
    )

    // ---- a malformed author is refused rather than read as absent
    const t5 = await stage(at, 'tasks/five.md', '# five\n')
    const bad = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add five',
      tree: t5,
      author: 'Dana Wu <dana@example.com>',
    })
    check('a non-object author is 422', bad.status === 422, String(bad.status))
    const badc = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add five',
      tree: t5,
      committer: ['Dana Wu'],
    })
    check('a non-object committer is 422', badc.status === 422, String(badc.status))

    // ---- a committer without an author keeps the committer, and the author
    // fills with the endpoint's default identity rather than vanishing
    const tSolo = await stage(at, 'tasks/solo.md', '# solo\n')
    const solo = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add solo',
      tree: tSolo,
      committer: { name: 'Sam Iyer', email: 'sam@example.com', date: '2025-09-05T09:15:00+08:00' },
    })
    eq('a committer alone is kept', field(solo.body, 'committer'), {
      name: 'Sam Iyer',
      email: 'sam@example.com',
      date: '2025-09-05T09:15:00+08:00',
    })
    eq('and the author fills with the default identity', field(solo.body, 'author'), {
      name: 'integ-user',
      email: 'integ-user@users.noreply.github.com',
      date: '2026-01-01T00:00:00Z',
    })

    process.stdout.write(`github selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
