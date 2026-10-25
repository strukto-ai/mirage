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

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DiscordApiError } from '@struktoai/mirage-core/core/discord/client'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import { MountMode } from '@struktoai/mirage-core/types'
import { MirageFS } from '@struktoai/mirage-node/fuse/fs'
import { MountCore } from '@struktoai/mirage-core/mount/core'
import { classifyError } from '@struktoai/mirage-node/mount/errors'
import type { MountAttrs } from '@struktoai/mirage-core/mount/types'
import { DiscordVFS } from '@struktoai/mirage-node/vfs/discord/discord'
import { Workspace } from '@struktoai/mirage-node/workspace'

interface Case {
  id: string
  adapter: 'core' | 'fuse'
  kind: 'hydrate' | 'failure' | 'policy'
  early_close?: boolean
  status?: number
  recover?: boolean
  restriction?: string
  expected_errno?: number
  expected_statuses: number[]
}
interface Corpus {
  file: string
  guild: unknown
  channel: unknown
  messages: unknown[]
  body: string
  partial: { offset: number; size: number }
  cases: Case[]
}
const corpus = JSON.parse(
  await readFile(new URL('./discord_cases.json', import.meta.url), 'utf8'),
) as Corpus
const file = corpus.file
const body = new TextEncoder().encode(corpus.body)

class DiscordHTTP {
  status = 403
  requests: string[] = []
  statuses: number[] = []
  responses: Response[] = []
  readonly fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    assert.equal(url.origin, 'https://discord.test')
    assert.equal(init?.method, 'GET')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bot test-token')
    this.requests.push(url.pathname)
    let payload: unknown
    let status = 200
    if (url.pathname === '/users/@me/guilds') payload = [corpus.guild]
    else if (url.pathname === '/guilds/G1/channels') payload = [corpus.channel]
    else {
      assert.equal(url.pathname, '/channels/C1/messages')
      assert.equal(url.searchParams.get('limit'), '100')
      assert(url.searchParams.has('after'))
      status = this.status
      this.statuses.push(status)
      payload =
        status === 200 ? [...corpus.messages].reverse() : { message: 'refused', retry_after: 0 }
    }
    const response = new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
    this.responses.push(response)
    return Promise.resolve(response)
  }
}

interface Reply<T> {
  code: number
  value?: T
  error?: unknown
}
async function captured<T>(pending: Promise<T>): Promise<Reply<T>> {
  try {
    return { code: 0, value: await pending }
  } catch (error) {
    return { code: classifyError(error), error }
  }
}
function callback<T>(fs: MirageFS, name: string, ...args: unknown[]): Promise<Reply<T>> {
  const operation = (fs.ops() as Record<string, (...args: unknown[]) => void>)[name]
  assert(operation !== undefined)
  return new Promise((resolve) =>
    operation(...args, (code: number, value?: T) =>
      resolve(value === undefined ? { code } : { code, value }),
    ),
  )
}
class Driver {
  readonly core: MountCore
  readonly fuse: MirageFS | null
  readonly opened = new Set<number>()
  constructor(ws: Workspace, adapter: Case['adapter']) {
    const session = ws.createSession('reader')
    this.fuse = adapter === 'fuse' ? new MirageFS(ws.vfs, { session }) : null
    this.core = this.fuse?.core ?? new MountCore(ws.vfs, { session })
  }
  getattr(fd?: number): Promise<Reply<MountAttrs>> {
    if (this.fuse !== null)
      return fd === undefined
        ? callback(this.fuse, 'getattr', file)
        : callback(this.fuse, 'fgetattr', file, fd)
    return captured(fd === undefined ? this.core.getattr(file) : this.core.fgetattr(file, fd))
  }
  async size(fd?: number): Promise<number> {
    const result = await this.getattr(fd)
    assert.equal(result.code, 0)
    assert(result.value !== undefined)
    return result.value.size
  }
  async open(): Promise<number> {
    const result =
      this.fuse === null
        ? await captured(this.core.open(file))
        : await callback<number>(this.fuse, 'open', file, 0)
    assert.equal(result.code, 0)
    assert(result.value !== undefined)
    this.opened.add(result.value)
    return result.value
  }
  async read(fd: number, offset = 0, size = body.length + 10): Promise<Reply<Uint8Array>> {
    if (this.fuse === null) return captured(this.core.read(file, fd, offset, size))
    const buffer = Buffer.alloc(size, 0xa5)
    const result = await callback<never>(this.fuse, 'read', file, fd, buffer, size, offset)
    if (result.code < 0) {
      assert.deepEqual(buffer, Buffer.alloc(size, 0xa5))
      return { code: result.code }
    }
    return { code: 0, value: new Uint8Array(buffer.subarray(0, result.code)) }
  }
  async release(fd: number): Promise<void> {
    const result =
      this.fuse === null
        ? await captured(this.core.release(fd))
        : await callback(this.fuse, 'release', file, fd)
    assert.equal(result.code, 0)
    this.opened.delete(fd)
    assert(!this.core.handles.has(fd))
  }
  async close(): Promise<void> {
    for (const fd of this.opened) await this.release(fd)
    assert.deepEqual([...this.core.handles.values()], [])
  }
}
async function checkedRead(
  driver: Driver,
  fd: number,
  expected: Uint8Array,
  offset = 0,
  size = body.length + 10,
): Promise<void> {
  const result = await driver.read(fd, offset, size)
  assert.equal(result.code, 0)
  assert.deepEqual(result.value, expected)
}

async function run(test: Case): Promise<void> {
  const http = new DiscordHTTP()
  const originalFetch = globalThis.fetch
  globalThis.fetch = http.fetch
  let stage = ''
  const seen: string[] = []
  const policy: Policy = {
    preVfs(ctx) {
      if (ctx.call.name !== 'read' || stage !== 'pre_vfs') return null
      seen.push(stage)
      return { kind: 'deny', reason: 'sealed' }
    },
    postVfs(ctx) {
      if (ctx.call.name !== 'read' || stage !== 'post_vfs') return null
      assert.deepEqual(ctx.result, body)
      seen.push(stage)
      return { kind: 'deny', reason: 'sealed' }
    },
  }
  const backend = new DiscordVFS({ token: 'test-token', baseUrl: 'https://discord.test' })
  const ws = new Workspace({ '/discord/': backend }, { mode: MountMode.READ, policies: [policy] })
  const driver = new Driver(ws, test.adapter)
  try {
    assert.equal((await ws.vfs.stat(file)).size, null)
    assert.equal(await driver.size(), 0)
    assert.deepEqual(http.statuses, [403])
    http.status = test.status ?? 200
    const fd = await driver.open()
    if (test.kind === 'failure') {
      assert.equal(driver.core.handles.get(fd)?.data, undefined)
      const result = await driver.read(fd)
      assert.equal(result.code, -(test.expected_errno ?? 0))
      assert.equal(result.value, undefined)
      assert.equal(driver.core.handles.get(fd)?.data, undefined)
      if (test.adapter === 'core') {
        assert(result.error instanceof DiscordApiError)
        assert.equal(result.error.status, test.status)
      }
      if (test.recover === true) {
        http.status = 200
        await checkedRead(driver, fd, body)
        assert.equal(await driver.size(fd), body.length)
      }
    } else {
      assert.equal(await driver.size(fd), body.length)
      if (test.kind === 'hydrate') {
        const { offset, size } = corpus.partial
        await checkedRead(driver, fd, body.slice(offset, offset + size), offset, size)
        if (test.early_close !== true) {
          await checkedRead(driver, fd, body)
          await checkedRead(driver, fd, new Uint8Array(), body.length, 9)
        }
      } else {
        await checkedRead(driver, fd, body)
        const before = http.requests.length
        const restriction = test.restriction
        if (restriction === 'hide')
          await ws.setSessionProfile('reader', { paths: { hide: [file] } })
        else if (restriction === 'deny')
          await ws.setSessionProfile('reader', {
            commands: { deny: [{ paths: [file], reason: 'sealed' }] },
          })
        else {
          assert(restriction !== undefined)
          stage = restriction
        }
        assert.equal((await driver.read(fd)).code, -(test.expected_errno ?? 0))
        if (restriction === 'hide') assert.equal((await driver.getattr(fd)).code, -2)
        if (restriction === 'pre_vfs' || restriction === 'post_vfs')
          assert.deepEqual(seen, [restriction])
        assert.equal(http.requests.length, before)
        stage = ''
        await ws.setSessionProfile('reader', {})
        await checkedRead(driver, fd, body)
        assert.equal(http.requests.length, before)
      }
    }
    const before = http.requests.length
    await driver.release(fd)
    assert.equal(http.requests.length, before)
    assert.deepEqual(http.statuses, test.expected_statuses)
  } finally {
    try {
      await driver.close()
    } finally {
      try {
        await ws.close()
        assert(http.responses.every((response) => response.bodyUsed))
      } finally {
        globalThis.fetch = originalFetch
      }
    }
  }
}
for (const test of corpus.cases) {
  try {
    await run(test)
  } catch (cause) {
    throw new Error(test.id, { cause })
  }
  console.log(JSON.stringify({ id: test.id, ok: true }))
}
