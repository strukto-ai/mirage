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

import { DiscordApiError } from '@struktoai/mirage-core/core/discord/client'
import { FileType, MountMode } from '@struktoai/mirage-core/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MountCore } from '../mount/core.ts'
import { classifyError, EACCES, EIO, ENOENT } from '../mount/errors.ts'
import type { MountAttrs } from '../mount/types.ts'
import { DiscordVFS } from '../vfs/discord/discord.ts'
import { Workspace } from '../workspace.ts'
import { MirageFS } from './fs.ts'

const GUILD = { id: 'G1', name: 'TestGuild' }
const CHANNEL = { id: 'C1', name: 'general', type: 0, last_message_id: '1196423538278400001' }
const MESSAGES = [
  { id: '1196423538278400000', content: 'hello', author: { username: 'alice' } },
  { id: '1196423538278400001', content: 'world', author: { username: 'bob' } },
]
const FILE = '/discord/TestGuild__G1/channels/general__C1/2024-01-15/chat.jsonl'
const BYTES = new TextEncoder().encode(
  MESSAGES.map((message) => JSON.stringify(message)).join('\n') + '\n',
)

type Adapter = 'core' | 'fuse'
interface Reply<T> {
  code: number
  value?: T
  error?: unknown
}

class DiscordHTTP {
  status = 403
  readonly messageStatuses: number[] = []
  readonly responses: Response[] = []
  readonly fetch = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    expect(url.origin).toBe('https://discord.test')
    expect(init?.method).toBe('GET')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bot test-token')
    let body: unknown
    let status = 200
    if (url.pathname === '/users/@me/guilds') body = [GUILD]
    else if (url.pathname === '/guilds/G1/channels') body = [CHANNEL]
    else if (url.pathname === '/channels/C1/messages') {
      expect(url.searchParams.get('limit')).toBe('100')
      expect(url.searchParams.has('after')).toBe(true)
      status = this.status
      this.messageStatuses.push(status)
      body = status === 200 ? [...MESSAGES].reverse() : { message: 'refused', retry_after: 0 }
    } else throw new Error(`unexpected Discord request: ${url.pathname}`)
    const response = new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
    this.responses.push(response)
    return Promise.resolve(response)
  })
}

async function captured<T>(pending: Promise<T>): Promise<Reply<T>> {
  try {
    return { code: 0, value: await pending }
  } catch (error) {
    return { code: classifyError(error), error }
  }
}

async function callback<T>(fs: MirageFS, name: string, ...args: unknown[]): Promise<Reply<T>> {
  const operation = (fs.ops() as Record<string, (...args: unknown[]) => void>)[name]
  if (operation === undefined) throw new Error(`missing FUSE callback: ${name}`)
  return new Promise((resolve) => {
    operation(...args, (code: number, value?: T) => {
      resolve(value === undefined ? { code } : { code, value })
    })
  })
}

class Driver {
  readonly core: MountCore
  readonly fs: MirageFS | null
  private readonly opened = new Set<number>()

  constructor(
    readonly kind: Adapter,
    ws: Workspace,
  ) {
    const session = ws.createSession('reader')
    this.fs = kind === 'fuse' ? new MirageFS(ws.vfs, { session }) : null
    this.core = this.fs?.core ?? new MountCore(ws.vfs, { session })
  }

  async getattr(fd?: number): Promise<Reply<MountAttrs>> {
    if (this.fs !== null) {
      return fd === undefined
        ? callback(this.fs, 'getattr', FILE)
        : callback(this.fs, 'fgetattr', FILE, fd)
    }
    return captured(fd === undefined ? this.core.getattr(FILE) : this.core.fgetattr(FILE, fd))
  }

  async open(): Promise<number> {
    const result =
      this.fs === null
        ? await captured(this.core.open(FILE))
        : await callback<number>(this.fs, 'open', FILE, 0)
    expect(result.code).toBe(0)
    if (result.value === undefined) throw new Error('open returned no handle')
    this.opened.add(result.value)
    return result.value
  }

  async read(fd: number, offset = 0, size = BYTES.length + 10): Promise<Reply<Uint8Array>> {
    if (this.fs === null) return captured(this.core.read(FILE, fd, offset, size))
    const buffer = Buffer.alloc(size, 0xa5)
    const result = await callback<never>(this.fs, 'read', FILE, fd, buffer, size, offset)
    if (result.code < 0) {
      expect(buffer).toEqual(Buffer.alloc(size, 0xa5))
      return { code: result.code }
    }
    return { code: 0, value: new Uint8Array(buffer.subarray(0, result.code)) }
  }

  async release(fd: number): Promise<void> {
    const result =
      this.fs === null
        ? await captured(this.core.release(fd))
        : await callback(this.fs, 'release', FILE, fd)
    expect(result.code).toBe(0)
    this.opened.delete(fd)
    expect(this.core.handles.has(fd)).toBe(false)
  }

  async close(): Promise<void> {
    for (const fd of this.opened) await this.release(fd)
    expect([...this.core.handles.values()]).toEqual([])
  }
}

async function world(kind: Adapter) {
  const http = new DiscordHTTP()
  vi.stubGlobal('fetch', http.fetch)
  const vfs = new DiscordVFS({ token: 'test-token', baseUrl: 'https://discord.test' })
  const ws = new Workspace({ '/discord/': vfs }, { mode: MountMode.READ })
  const stat = await ws.vfs.stat(FILE)
  expect(stat.type).toBe(FileType.FILE)
  expect(stat.size).toBeNull()
  expect(http.messageStatuses).toEqual([403])
  const driver = new Driver(kind, ws)
  return {
    ws,
    http,
    driver,
    async close(): Promise<void> {
      try {
        await driver.close()
      } finally {
        await ws.close()
      }
      expect(http.responses.every((response) => response.bodyUsed)).toBe(true)
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(['core', 'fuse'] as const)('Discord through %s', (kind) => {
  it.each([false, true])(
    'hydrates an unknown-size file and serves ranges (early close: %s)',
    async (earlyClose) => {
      const fixture = await world(kind)
      const { driver, http } = fixture
      try {
        expect((await driver.getattr()).value?.size).toBe(0)
        expect(http.messageStatuses).toEqual([403])
        http.status = 200
        const fd = await driver.open()
        expect(http.messageStatuses).toEqual([403, 200])
        expect((await driver.getattr(fd)).value?.size).toBe(BYTES.length)
        expect((await driver.read(fd, 3, 9)).value).toEqual(BYTES.slice(3, 12))
        if (!earlyClose) {
          expect((await driver.read(fd)).value).toEqual(BYTES)
          expect((await driver.read(fd, BYTES.length, 9)).value).toEqual(new Uint8Array())
        }
        expect(http.messageStatuses).toEqual([403, 200])
        await driver.release(fd)
      } finally {
        await fixture.close()
      }
    },
  )

  it.each(
    [401, 403, 429].flatMap((status) => [false, true].map((recover) => ({ status, recover }))),
  )('defers HTTP $status hydration failure (recover: $recover)', async ({ status, recover }) => {
    const fixture = await world(kind)
    const { driver, http } = fixture
    try {
      http.status = status
      const attempts = status === 429 ? 3 : 1
      const fd = await driver.open()
      expect(http.messageStatuses).toEqual([403, ...Array<number>(attempts).fill(status)])
      expect(driver.core.handles.get(fd)?.data).toBeUndefined()
      const result = await driver.read(fd)
      expect(result.code).toBe(-EIO)
      expect(result.value).toBeUndefined()
      if (kind === 'core') {
        expect(result.error).toBeInstanceOf(DiscordApiError)
        expect(result.error).toMatchObject({ status })
      }
      expect(http.messageStatuses).toEqual([403, ...Array<number>(attempts * 2).fill(status)])
      expect(driver.core.handles.get(fd)?.data).toBeUndefined()
      if (recover) {
        http.status = 200
        expect((await driver.read(fd)).value).toEqual(BYTES)
        expect((await driver.getattr(fd)).value?.size).toBe(BYTES.length)
      }
      const calls = http.fetch.mock.calls.length
      await driver.release(fd)
      expect(http.fetch.mock.calls).toHaveLength(calls)
      expect(http.messageStatuses).toEqual([
        403,
        ...Array<number>(attempts * 2).fill(status),
        ...(recover ? [200] : []),
      ])
    } finally {
      await fixture.close()
    }
  })

  it.each(['hide', 'deny'] as const)(
    'rechecks a warmed handle after session %s and restores it',
    async (restriction) => {
      const fixture = await world(kind)
      const { driver, http, ws } = fixture
      try {
        http.status = 200
        const fd = await driver.open()
        expect((await driver.read(fd)).value).toEqual(BYTES)
        const calls = http.fetch.mock.calls.length
        await ws.setSessionProfile(
          'reader',
          restriction === 'hide'
            ? { paths: { hide: [FILE] } }
            : { commands: { deny: [{ reason: 'sealed', paths: [FILE] }] } },
        )
        const expected = restriction === 'hide' ? -ENOENT : -EACCES
        expect((await driver.read(fd)).code).toBe(expected)
        if (restriction === 'hide') {
          expect((await driver.getattr(fd)).code).toBe(-ENOENT)
          expect((await driver.getattr()).code).toBe(-ENOENT)
        }
        expect(http.fetch.mock.calls).toHaveLength(calls)
        await ws.setSessionProfile('reader', {})
        expect((await driver.read(fd)).value).toEqual(BYTES)
        expect((await driver.getattr(fd)).value?.size).toBe(BYTES.length)
        expect(http.fetch.mock.calls).toHaveLength(calls)
        await driver.release(fd)
      } finally {
        await fixture.close()
      }
    },
  )
})
