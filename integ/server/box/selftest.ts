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

import { deepStrictEqual } from 'node:assert'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-box'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`box selftest failed: ${name} ${detail}`)
}

interface Fake {
  stop: () => Promise<void>
  endpoint: string
}

function spawnFakeServer() {
  return spawn(join(INTEG, 'node_modules', '.bin', 'tsx'), [join(HERE, 'main.ts'), '--port', '0'], {
    cwd: INTEG,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
}

async function launch(start = spawnFakeServer, startupTimeout = 10000): Promise<Fake> {
  const child = start()
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  const stop = async (): Promise<void> => {
    const force = setTimeout(() => {
      child.kill('SIGKILL')
    }, 2000)
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await closed
    } finally {
      clearTimeout(force)
    }
  }
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err = (err + d).slice(-65536)
  })
  try {
    const first = await new Promise<string>((ok, bad) => {
      let out = ''
      const finish = (error: Error | null, line = ''): void => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
        child.stdout.resume()
        if (error === null) ok(line)
        else bad(error)
      }
      const onData = (d: string): void => {
        out += d
        const nl = out.indexOf('\n')
        if (nl !== -1) finish(null, out.slice(0, nl))
      }
      const onError = (error: Error): void => finish(error)
      const onExit = (code: number | null): void =>
        finish(new Error(`fake exited ${String(code)} before announcing\n${err}`))
      const timer = setTimeout(
        () => finish(new Error(`fake startup timed out\n${err}`)),
        startupTimeout,
      )
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
    const endpoint = first.split('=').slice(1).join('=')
    if (!ANNOUNCE_RE.test(first) || endpoint === '')
      throw new Error(`invalid fake announcement: ${first}`)
    return { stop, endpoint }
  } catch (error) {
    await stop()
    throw error
  }
}

async function checkFailedLaunch(
  name: string,
  executable: string,
  args: string[],
  expected: RegExp,
  timeout = 10000,
): Promise<void> {
  let child: ReturnType<typeof spawnFakeServer> | undefined
  let closed = false
  let closing = Promise.resolve()
  let unexpected: Fake | undefined
  try {
    try {
      unexpected = await launch(() => {
        child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        closing = new Promise<void>((resolve) =>
          child?.once('close', () => {
            closed = true
            resolve()
          }),
        )
        return child
      }, timeout)
    } catch (error) {
      const closedAtRejection = closed
      check(
        `${name} reports its startup error`,
        error instanceof Error && expected.test(error.message),
      )
      check(`${name} closes its child before rejecting`, closedAtRejection)
      return
    }
    check(`${name} rejects startup`, false)
  } finally {
    if (unexpected !== undefined) await unexpected.stop()
    if (child !== undefined && !closed) child.kill('SIGKILL')
    await closing
  }
}

async function checkFailedLaunches(): Promise<void> {
  for (const [name, script, expected, timeout] of [
    [
      'malformed announcement',
      "console.log('bad'); setInterval(() => {}, 1000)",
      /invalid fake announcement/,
      10000,
    ],
    [
      'empty announcement',
      "console.log('BOX_URL='); setInterval(() => {}, 1000)",
      /invalid fake announcement/,
      10000,
    ],
    ['early exit', 'process.exit(7)', /fake exited 7 before announcing/, 10000],
    ['silent startup', 'setInterval(() => {}, 1000)', /fake startup timed out/, 100],
    [
      'ignored SIGTERM',
      "process.on('SIGTERM', () => {}); console.log('bad'); setInterval(() => {}, 1000)",
      /invalid fake announcement/,
      10000,
    ],
  ] as const) {
    await checkFailedLaunch(name, process.execPath, ['-e', script], expected, timeout)
  }
  await checkFailedLaunch(
    'missing executable',
    join(HERE, 'missing-box-selftest-executable'),
    [],
    /ENOENT/,
  )
}

const AUTH = { Authorization: `Bearer ${TENANT}` }

function sha1Of(body: string): string {
  return createHash('sha1').update(body).digest('hex')
}

async function json(r: Response): Promise<Record<string, unknown>> {
  return (await r.json()) as Record<string, unknown>
}

function form(attributes: Record<string, unknown>, body: string): FormData {
  const f = new FormData()
  f.append('attributes', JSON.stringify(attributes))
  f.append('file', new Blob([body]), 'c.txt')
  return f
}

async function info(endpoint: string, id: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${endpoint}/2.0/files/${id}`, { headers: AUTH })
  check(`GET /2.0/files/${id} is 200`, r.status === 200, String(r.status))
  return json(r)
}

async function download(endpoint: string, id: string, range?: string): Promise<Response> {
  return fetch(`${endpoint}/2.0/files/${id}/content`, {
    headers: { ...AUTH, ...(range ? { Range: range } : {}) },
  })
}

async function main(): Promise<void> {
  await checkFailedLaunches()
  const fake = await launch()
  try {
    check('valid announcement launches the fake', fake.endpoint !== '')
    const reset = await fetch(`${fake.endpoint}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT] }),
    })
    check('/reset creates the tenant', reset.status === 200, String(reset.status))
    await reset.arrayBuffer()

    const ids = new Map<string, string>([['0', '0']])
    let parentId = '0'
    for (const [goldenId, name] of [
      ['100', 'a'],
      ['101', 'b'],
    ] as const) {
      const made = await fetch(`${fake.endpoint}/2.0/folders`, {
        method: 'POST',
        headers: { ...AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parent: { id: parentId } }),
      })
      const folder = await json(made)
      check(`folder ${name} is created`, made.status === 201, String(made.status))
      parentId = String(folder.id)
      ids.set(goldenId, parentId)
    }

    const up = await fetch(`${fake.endpoint}/2.0/files/content`, {
      method: 'POST',
      headers: AUTH,
      body: form({ name: 'c.txt', parent: { id: parentId } }, 'x'),
    })
    const uploaded = await json(up)
    const uploadedFile = (uploaded.entries as Record<string, unknown>[])[0] ?? {}
    const id = String(uploadedFile.id)
    ids.set('102', id)
    check('c.txt is uploaded', up.status === 201, String(up.status))

    const first = await info(fake.endpoint, id)
    const chain = (
      (first.path_collection as { entries?: { id: string }[] } | undefined)?.entries ?? []
    ).map((e) => e.id)
    check(
      'path_collection runs from All Files to the parent',
      JSON.stringify(chain) === JSON.stringify(['0', ids.get('100'), parentId]),
      JSON.stringify(chain),
    )
    check('item_status is active', first.item_status === 'active', String(first.item_status))
    check('the name is the file name', first.name === 'c.txt', String(first.name))
    check('size is the byte length', first.size === 1, String(first.size))
    check(
      'modified_at is set',
      typeof first.modified_at === 'string' && first.modified_at !== '',
      String(first.modified_at),
    )

    const cases = JSON.parse(
      await readFile(join(INTEG, 'fixtures', 'box', 'wire.json'), 'utf8'),
    ) as { path: string; status: number; body: Record<string, unknown> }[]
    const listings = cases.filter((item) => item.path.startsWith('/2.0/folders/101/items?'))
    check('shared wire corpus contains one nested listing', listings.length === 1)
    for (const item of listings) {
      const path = item.path.replace('/folders/101/', `/folders/${parentId}/`)
      const response = await fetch(`${fake.endpoint}${path}&limit=1`, { headers: AUTH })
      const expected = JSON.parse(
        JSON.stringify(item.body, (key: string, value: unknown) => {
          if (key === 'id' && typeof value === 'string') return ids.get(value) ?? value
          if (key === 'modified_at') return uploadedFile.modified_at
          return value
        }),
      ) as Record<string, unknown>
      expected.limit = 1
      check('nested listing matches the shared status', response.status === item.status)
      deepStrictEqual(await json(response), expected)
      check('nested listing matches the shared wire body', true)
    }

    const whole = await download(fake.endpoint, id)
    const body = await whole.text()
    check('a whole download is the file', whole.status === 200 && body === 'x')
    check(
      'sha1 is the SHA-1 of the downloaded bytes',
      first.sha1 === sha1Of(body),
      String(first.sha1),
    )

    const version = await fetch(`${fake.endpoint}/2.0/files/${id}/content`, {
      method: 'POST',
      headers: AUTH,
      body: form({}, '0123456789'),
    })
    check('a version for range checks is accepted', version.status === 200, String(version.status))
    await version.arrayBuffer()

    const ranged = await download(fake.endpoint, id, 'bytes=2-4')
    check(
      'a ranged download is a 206 window',
      ranged.status === 206 && (await ranged.text()) === '234',
      String(ranged.status),
    )

    const again = await fetch(`${fake.endpoint}/2.0/files/${id}/content`, {
      method: 'POST',
      headers: AUTH,
      body: form({}, '9876543210'),
    })
    check('a same-size new version is accepted', again.status === 200, String(again.status))
    await again.arrayBuffer()
    const next = await info(fake.endpoint, id)
    check(
      'a same-size rewrite moves the sha1',
      next.sha1 === sha1Of('9876543210'),
      String(next.sha1),
    )

    process.stdout.write(`box selftest: ${String(checks)} checks passed\n`)
  } finally {
    await fake.stop()
  }
}

await main()
