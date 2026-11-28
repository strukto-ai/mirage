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

import { constants as osConstants } from 'node:os'
import { FileType, MountMode } from '@struktoai/mirage-core/types'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MountCore } from '@struktoai/mirage-core/mount/core'
import { classifyError } from '../mount/errors.ts'
import type { MountAttrs } from '@struktoai/mirage-core/mount/types'
import { DiscordVFS } from '@struktoai/mirage-core/vfs/direct/discord'
import { serve } from '../../../core/tests/fixtures/kit_fake.ts'
import { DAY, DiscordGuild, GENERAL, MESSAGES } from '../../../core/tests/fixtures/discord_guild.ts'
import { Workspace } from '../workspace.ts'
import { MirageFS } from './fs.ts'

const FILE = `/discord/My Server__111/channels/general__211/${DAY}/chat.jsonl`

type Adapter = 'core' | 'fuse'

interface Reply<T> {
  code: number
  value?: T
  error?: unknown
}

let origin = ''
let guild: DiscordGuild

beforeAll(async () => {
  origin = await serve('discord')
})

beforeEach(async () => {
  guild = new DiscordGuild(origin)
  await guild.reset()
})

afterEach(async () => {
  await guild.close()
})

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

  async read(fd: number, offset = 0, size = 4096): Promise<Reply<Uint8Array>> {
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
  // general's chat.jsonl for the day: Discord's own messages, oldest first.
  const day = await guild.day(GENERAL, DAY)
  const bytes = new TextEncoder().encode(day.map((m) => JSON.stringify(m)).join('\n') + '\n')
  const vfs = new DiscordVFS(guild.config())
  const ws = new Workspace({ '/discord/': vfs }, { mode: MountMode.READ })
  const driver = new Driver(kind, ws)
  return {
    ws,
    driver,
    bytes,
    async close(): Promise<void> {
      try {
        await driver.close()
      } finally {
        await ws.close()
      }
    },
  }
}

async function listDay(ws: Workspace, bytes: Uint8Array): Promise<void> {
  const stat = await ws.vfs.stat(FILE)
  expect(stat.type).toBe(FileType.FILE)
  expect(stat.size).toBe(bytes.length)
  expect(await guild.count(MESSAGES)).toBe(1)
}

describe.each(['core', 'fuse'] as const)('Discord through %s', (kind) => {
  it.each([false, true])(
    "serves a listed day's exact bytes and ranges (early close: %s)",
    async (earlyClose) => {
      const fixture = await world(kind)
      const { driver, ws, bytes } = fixture
      try {
        await listDay(ws, bytes)
        expect((await driver.getattr()).value?.size).toBe(bytes.length)
        const fd = await driver.open()
        expect(await guild.count(MESSAGES)).toBe(1)
        expect((await driver.getattr(fd)).value?.size).toBe(bytes.length)
        expect((await driver.read(fd, 3, 9)).value).toEqual(bytes.slice(3, 12))
        if (!earlyClose) {
          expect((await driver.read(fd)).value).toEqual(bytes)
          expect((await driver.read(fd, bytes.length, 9)).value).toEqual(new Uint8Array())
        }
        expect(await guild.count(MESSAGES)).toBe(2)
        await driver.release(fd)
      } finally {
        await fixture.close()
      }
    },
  )

  it.each([
    [401, 1, -osConstants.errno.EACCES],
    [403, 1, -osConstants.errno.EACCES],
    [429, 3, -osConstants.errno.EIO],
  ] as const)(
    'refuses a day Discord answers %i for and caches no empty answer',
    async (status, attempts, code) => {
      const fixture = await world(kind)
      const { driver, bytes } = fixture
      try {
        await guild.refuse(MESSAGES, status)
        expect((await driver.getattr()).code).toBe(code)
        expect(await guild.count(MESSAGES)).toBe(attempts)
        await guild.run.clearAnswers()
        expect((await driver.getattr()).value?.size).toBe(bytes.length)
        expect(await guild.count(MESSAGES)).toBe(attempts + 1)
      } finally {
        await fixture.close()
      }
    },
  )

  it('rechecks a warmed handle after a session hide and restores it', async () => {
    const fixture = await world(kind)
    const { driver, ws, bytes } = fixture
    try {
      await listDay(ws, bytes)
      const fd = await driver.open()
      expect((await driver.read(fd)).value).toEqual(bytes)
      const calls = (await guild.run.requests()).length
      await ws.setSessionProfile('reader', { paths: { hide: [FILE] } })
      expect((await driver.read(fd)).code).toBe(-osConstants.errno.ENOENT)
      expect((await driver.getattr(fd)).code).toBe(-osConstants.errno.ENOENT)
      expect((await driver.getattr()).code).toBe(-osConstants.errno.ENOENT)
      expect(await guild.run.requests()).toHaveLength(calls)
      await ws.setSessionProfile('reader', {})
      expect((await driver.read(fd)).value).toEqual(bytes)
      expect((await driver.getattr(fd)).value?.size).toBe(bytes.length)
      expect(await guild.run.requests()).toHaveLength(calls)
      await driver.release(fd)
    } finally {
      await fixture.close()
    }
  })
})
