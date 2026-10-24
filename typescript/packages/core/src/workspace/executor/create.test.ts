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

import { describe, expect, it } from 'vitest'

import { chunks } from '../../io/cooperative.ts'
import { MEMORY_LIMIT } from '../../io/spool.ts'
import { IOResult, materialize, type ByteSource } from '../../io/types.ts'
import { FileDescription } from '../../shell/descriptors.ts'
import type { DispatchFn } from '../../runtime/types.ts'
import { FileStat, FileType, PathSpec } from '../../types.ts'
import { SessionState } from '../session/session.ts'
import { createFile, writeDescription } from './create.ts'

const SCOPE = new PathSpec({ virtual: '/data/f', directory: '/data/', vfsPath: '' })

class FakeDispatch {
  readonly calls: [string, Record<string, unknown>][] = []

  constructor(private readonly exists: boolean) {}

  readonly fn: DispatchFn = async (op, _path, _args, kwargs) => {
    this.calls.push([op, kwargs ?? {}])
    await Promise.resolve()
    if (op === 'stat' && !this.exists) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return [null, new IOResult()]
  }

  ops(): string[] {
    return this.calls.map(([op]) => op)
  }
}

function sessionWithUmask(umask: number): SessionState {
  const session = new SessionState({ sessionId: 's' })
  session.umask = umask
  return session
}

// Both `echo x > f` and `exec > f` route here, so the mode a fresh file
// gets is decided once: 0666 masked by the session's umask, and left
// alone under the default mask because a fresh file already reads 644.
describe('createFile', () => {
  it('never probes or sets a mode under the default umask', async () => {
    const d = new FakeDispatch(false)
    await createFile(d.fn, new SessionState({ sessionId: 's' }), SCOPE, new Uint8Array(0))
    expect(d.ops()).toEqual(['write'])
  })

  it('gives a created file the masked mode', async () => {
    const d = new FakeDispatch(false)
    await createFile(d.fn, sessionWithUmask(0o077), SCOPE, new Uint8Array(0))
    expect(d.ops()).toEqual(['stat', 'write', 'setattr'])
    expect(d.calls[2]?.[1].mode).toBe(0o600)
  })

  it('leaves an existing file its mode', async () => {
    const d = new FakeDispatch(true)
    await createFile(d.fn, sessionWithUmask(0o077), SCOPE, new Uint8Array(0))
    expect(d.ops()).toEqual(['stat', 'write'])
  })
})

async function* aBlockThenAByte(): AsyncGenerator<Uint8Array> {
  await Promise.resolve()
  yield new Uint8Array(MEMORY_LIMIT)
  yield new Uint8Array(1)
}

describe('writeDescription', () => {
  it('leaves the offset after what landed when a later write fails', async () => {
    const landed: [number, number][] = []
    const dispatch: DispatchFn = async (op, _path, args) => {
      await Promise.resolve()
      if (op === 'pwrite') {
        if (landed.length > 0) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        const [part, offset] = args as [Uint8Array, number]
        landed.push([offset, part.byteLength])
      }
      return [null, new IOResult()]
    }
    const file = new FileDescription(SCOPE)
    file.opened = true
    file.offset = 3
    await expect(
      writeDescription(dispatch, new SessionState({ sessionId: 's' }), file, aBlockThenAByte()),
    ).rejects.toThrow('ENOSPC')
    expect(landed).toEqual([[3, MEMORY_LIMIT]])
    expect(file.offset).toBe(3 + MEMORY_LIMIT)
  })

  it.each([
    [0, ['stat', 'write']],
    [5, ['stat', 'pwrite', 'pwrite']],
  ])('lands a first write into a file of %i bytes as %j', async (size, ops) => {
    const calls: string[] = []
    const dispatch: DispatchFn = async (op, _path, args) => {
      calls.push(op)
      if (op === 'stat') {
        return [new FileStat({ name: 'f', size, type: FileType.FILE }), new IOResult()]
      }
      if (op === 'write') await materialize((args as [ByteSource])[0])
      return [null, new IOResult()]
    }
    const file = new FileDescription(SCOPE)
    file.opened = true
    await writeDescription(dispatch, new SessionState({ sessionId: 's' }), file, aBlockThenAByte())
    expect(calls).toEqual(ops)
    expect(file.offset).toBe(MEMORY_LIMIT + 1)
  })

  it('sends a second first write meanwhile through the windows', async () => {
    const ops: string[] = []
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => (release = resolve))
    const dispatch: DispatchFn = async (op, _path, args) => {
      ops.push(op)
      if (op === 'stat') {
        return [new FileStat({ name: 'f', size: 0, type: FileType.FILE }), new IOResult()]
      }
      if (op === 'write') {
        await released
        await materialize((args as [ByteSource])[0])
      }
      return [null, new IOResult()]
    }
    const first = new FileDescription(SCOPE)
    first.opened = true
    const second = new FileDescription(SCOPE)
    second.opened = true
    const session = new SessionState({ sessionId: 's' })
    const writing = writeDescription(dispatch, session, first, aBlockThenAByte())
    while (!ops.includes('write')) await Promise.resolve()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('second write waited on the first'))
      }, 5000)
    })
    try {
      await Promise.race([
        writeDescription(dispatch, session, second, new Uint8Array([0x61, 0x62])),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
      release()
    }
    await writing
    expect(ops).toEqual(['stat', 'write', 'pwrite'])
    expect([first.offset, second.offset]).toEqual([MEMORY_LIMIT + 1, 2])
  })

  it('leaves the offset at what landed when a first write fails', async () => {
    let landed = 0
    const dispatch: DispatchFn = async (op, _path, args) => {
      if (op === 'stat') {
        return [new FileStat({ name: 'f', size: landed, type: FileType.FILE }), new IOResult()]
      }
      if (op === 'write') {
        for await (const part of chunks((args as [ByteSource])[0])) {
          landed += part.byteLength
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        }
      }
      return [null, new IOResult()]
    }
    const file = new FileDescription(SCOPE)
    file.opened = true
    await expect(
      writeDescription(dispatch, new SessionState({ sessionId: 's' }), file, aBlockThenAByte()),
    ).rejects.toThrow('ENOSPC')
    expect(landed).toBeGreaterThan(0)
    expect(file.offset).toBe(landed)
  })
})
