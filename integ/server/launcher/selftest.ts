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
import { existsSync, readdirSync } from 'node:fs'
import { readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import type { JsonValue } from '../kit/typescript/types.ts'
import { knownFakes, launch } from './main.ts'

// What a launched fake has to be is INDISTINGUISHABLE from a standalone one,
// so most of this asserts the properties a merge could quietly break: two
// instances of one fake holding different worlds, a non-HTTP arm still coming
// up, and a teardown that actually closes the sockets.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`launcher selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

function urlOf(lines: Map<string, string>, token: string): string {
  const v = lines.get(token)
  if (v === undefined) throw new Error(`no announce for ${token}`)
  return v
}

async function repoNames(base: string): Promise<string[]> {
  const r = await fetch(`${base}/users/integ/repos`, { headers: { authorization: 'token x' } })
  const body = (await r.json()) as JsonValue
  return Array.isArray(body)
    ? body.map((x) => String((x as Record<string, JsonValue>).name ?? ''))
    : []
}

function reachable(hostPort: string): Promise<boolean> {
  const [host = '', port = ''] = hostPort.split(':')
  return new Promise<boolean>((done) => {
    const sock = createConnection({ host, port: Number(port) }, () => {
      sock.destroy()
      done(true)
    })
    sock.on('error', () => {
      done(false)
    })
    sock.setTimeout(3000, () => {
      sock.destroy()
      done(false)
    })
  })
}

async function inProcess(): Promise<void> {
  // The same fake twice, which is the reason the config is a map and not a
  // list: CI serves github seeded `cli` for the gh battery and github seeded
  // `empty` for the watch battery, and the two run at once.
  const started = await launch({
    github: { fixture: 'cli' },
    'github-empty': { fake: 'github', fixture: 'empty', token: 'GITHUB_EMPTY_URL' },
    mail: { imapPort: 0, smtpPort: 0 },
  })
  const lines = new Map<string, string>()
  for (const inst of started) for (const a of inst.announces) lines.set(a.token, a.url)
  try {
    check('one call started three instances', started.length === 3, String(started.length))
    check(
      'every announce line is well formed',
      [...lines].every(
        ([t, u]) =>
          ANNOUNCE_RE.test(`${t}=${u}`) || u.startsWith('imap://') || u.startsWith('smtp://'),
      ),
      [...lines.keys()].join(','),
    )

    // Two ports, not one. The merge is of processes; a shared listener would
    // be the other design and would change what a client has to know.
    const a = new URL(urlOf(lines, 'GITHUB_URL')).port
    const b = new URL(urlOf(lines, 'GITHUB_EMPTY_URL')).port
    check('the two github instances took different ports', a !== b, `${a} vs ${b}`)

    // And they are different WORLDS, not one store answering twice.
    eq('the cli-seeded instance has its repo', await repoNames(urlOf(lines, 'GITHUB_URL')), [
      'repo-cli',
    ])
    eq('the empty-seeded instance has none', await repoNames(urlOf(lines, 'GITHUB_EMPTY_URL')), [])

    // A token override is what keeps the second instance from overwriting the
    // first's environment variable.
    check('the token override renamed the line', lines.has('GITHUB_EMPTY_URL'), 'present')

    // A non-HTTP arm comes up under the launcher exactly as under main.ts.
    const imap = urlOf(lines, 'MAIL_IMAP_URL').replace('imap://', '')
    const smtp = urlOf(lines, 'MAIL_SMTP_URL').replace('smtp://', '')
    check('the IMAP arm is listening', await reachable(imap), imap)
    check('the SMTP arm is listening', await reachable(smtp), smtp)

    // Closing one instance must not close another's socket.
    const survivor = urlOf(lines, 'GITHUB_URL')
    const empty = started.find((i) => i.announces.some((x) => x.token === 'GITHUB_EMPTY_URL'))
    if (empty === undefined) throw new Error('no github-empty instance')
    await empty.close()
    eq('closing one leaves the others serving', await repoNames(survivor), ['repo-cli'])
    started.splice(started.indexOf(empty), 1)
  } finally {
    for (const inst of started) await inst.close()
  }
  check(
    'every socket closed on teardown',
    !(await reachable(urlOf(lines, 'MAIL_IMAP_URL').replace('imap://', ''))),
    'refused',
  )
}

// A bad config has to fail at launch. Reading a typo'd fake name as "skip it"
// would announce a healthy launcher missing a service, and the first symptom
// would be a battery failing to connect twenty minutes later.
async function refusals(): Promise<void> {
  const cases: Array<[string, Record<string, JsonValue>]> = [
    ['an unknown fake name is refused', { nope: {} }],
    ['a misspelled `fake` is refused', { alias: { fake: 'githbu' } }],
    ['a non-object entry is refused', { github: 'cli' as unknown as JsonValue }],
    ['a non-integer port is refused', { github: { port: 'ten' } }],
    ['an out-of-range port is refused', { github: { port: 99999 } }],
    ['a bad arm port is refused', { mail: { imapPort: -1 } }],
    ['a config naming no fakes is refused', { _note: 'prose only' }],
  ]
  for (const [name, cfg] of cases) {
    let threw = ''
    try {
      const started = await launch(cfg)
      for (const inst of started) await inst.close()
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    check(name, threw !== '', threw.slice(0, 60))
  }
  // Prose in the config is skipped, but ONLY with the underscore marker: the
  // same object with the marker removed has to fail, or the escape hatch is a
  // hole through which any typo walks.
  const noted = await launch({ _comment: ['why this port is pinned'], box: {} })
  check('an underscore key is prose, not a fake', noted.length === 1, String(noted.length))
  for (const inst of noted) await inst.close()
  let unmarked = ''
  try {
    await launch({ comment: ['why this port is pinned'] })
  } catch (e) {
    unmarked = e instanceof Error ? e.message : String(e)
  }
  check('the same key without the marker is refused', unmarked !== '', unmarked.slice(0, 50))

  // A refusal must leave NOTHING running. `mail` is the case that proves it:
  // its HTTP listener starts before the arm port is validated, so a launcher
  // that only rethrew would leak a socket and a SQLite pool here, and the
  // symptom is a selftest that passes every check and then never exits.
  const before = process.getActiveResourcesInfo().length
  try {
    await launch({ mail: { imapPort: -1 } })
  } catch {
    // asserted above; this call is here for the leak check that follows
  }
  const after = process.getActiveResourcesInfo().length
  check('a refused launch leaves nothing listening', after <= before, `${before} -> ${after}`)
}

// The registry's completeness is checked against the directory listing, not
// asserted in a comment: a fake added under server/ and forgotten in the
// registry would be startable on its own but not hostable, and nothing else
// in the repo would say so. The mapping is the directory name with underscores
// as hyphens (hf_hub serves as hf-hub), which is also how the announce token
// is derived, so one rule covers both.
function registryCoversEveryFake(): void {
  const root = join(HERE, '..')
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'fake.ts')))
    .map((d) => d.name.replace(/_/g, '-'))
    .sort()
  const known = knownFakes()
  eq('every server/*/fake.ts is hostable', dirs, known)
}

// The config a consumer is handed has to name fakes that exist. Checked
// without starting them, because the point is to catch a typo in the file, not
// to pay eleven startups for it.
function shippedConfig(): void {
  const raw = JSON.parse(readFileSync(join(INTEG, 'ci', 'fakes.json'), 'utf8')) as Record<
    string,
    JsonValue
  >
  const known = new Set(knownFakes())
  const names = Object.keys(raw).filter((k) => !k.startsWith('_'))
  const unknown = names.filter((n) => {
    const spec = raw[n]
    const which =
      typeof spec === 'object' &&
      spec !== null &&
      !Array.isArray(spec) &&
      typeof spec.fake === 'string'
        ? spec.fake
        : n
    return !known.has(which)
  })
  check(
    'ci/fakes.json names only registered fakes',
    unknown.length === 0,
    unknown.join(',') || `${String(names.length)} entries`,
  )
}

// And the process entry point, which is what CI would actually run.
async function spawned(): Promise<void> {
  const cfg = join(tmpdir(), 'mirage-launcher-selftest.json')
  writeFileSync(cfg, JSON.stringify({ box: {}, slack: {} }))
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--config', cfg],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  try {
    const lines = await new Promise<string[]>((ok, bad) => {
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        out += d
        const got = out.split('\n').filter((l) => l !== '')
        if (got.length >= 2) ok(got)
      })
      child.on('exit', (code) => {
        bad(new Error(`launcher exited ${String(code)} before announcing\n${err}`))
      })
    })
    check('the spawned launcher announced both fakes', lines.length === 2, lines.join(' '))
    check(
      'both lines match the announce contract',
      lines.every((l) => ANNOUNCE_RE.test(l)),
      lines.join(' '),
    )
    const box =
      lines
        .find((l) => l.startsWith('BOX_URL='))
        ?.split('=')
        .slice(1)
        .join('=') ?? ''
    const r = await fetch(`${box}/2.0/folders/0`, { headers: { authorization: 'Bearer x' } })
    check('the spawned box fake answers', r.status === 200, String(r.status))
  } finally {
    child.kill('SIGTERM')
  }
}

// A config naming no fake at all is a launcher that would announce nothing and
// sit there, which reads as a hang rather than a mistake, so it is refused
// outright instead of started as a healthy empty fleet.
async function empty(): Promise<void> {
  let threw = ''
  try {
    await launch({})
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  check('an empty config is refused', threw !== '', threw.slice(0, 60))
}

await inProcess()
await refusals()
await empty()
shippedConfig()
registryCoversEveryFake()
await spawned()
process.stdout.write(`launcher selftest: ${String(checks)} checks passed\n`)
