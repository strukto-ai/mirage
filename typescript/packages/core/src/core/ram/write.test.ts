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
import { RAMAccessor } from '../../accessor/ram.ts'
import { DevicePipe } from '../dev/pipe.ts'
import { DevFiles, DevStore } from '../../vfs/dev/store.ts'
import { RAMStore } from '../../vfs/ram/store.ts'
import { PathSpec } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { create } from './create.ts'
import { mkdir } from './mkdir.ts'
import { truncate } from './truncate.ts'
import { write } from './write.ts'
import { STREAM_PUBLISH_SECONDS } from './constants.ts'
import { capped, ramPath, tableBytes } from '../../test-utils.ts'
import { unlink } from './unlink.ts'

const ENC = new TextEncoder()

function mkPath(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    vfsPath: stripSlash(virtual),
    resolved: true,
  })
}

function mkAccessor(): RAMAccessor {
  const store = new RAMStore()
  store.files.set('/plain', ENC.encode('y'))
  store.dirs.add('/d')
  return new RAMAccessor(store)
}

async function codeOf(fn: () => Promise<void>): Promise<string> {
  try {
    await fn()
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE'
  }
  return 'NO_THROW'
}

describe('core/ram writeBytes destination parents', () => {
  it('writes into an existing directory', async () => {
    const acc = mkAccessor()
    await write(acc, mkPath('/d/f.txt'), ENC.encode('hi'))
    expect(acc.store.files.has('/d/f.txt')).toBe(true)
  })

  it('a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => write(acc, mkPath('/missing/f.txt'), ENC.encode('hi')))).toBe(
      'ENOENT',
    )
    expect(acc.store.files.has('/missing/f.txt')).toBe(false)
  })

  it('a missing grandparent is ENOENT', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => write(acc, mkPath('/missing/sub/f.txt'), ENC.encode('hi')))).toBe(
      'ENOENT',
    )
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => write(acc, mkPath('/plain/f.txt'), ENC.encode('hi')))).toBe('ENOTDIR')
    expect(acc.store.files.has('/plain/f.txt')).toBe(false)
  })

  it('a plain file deeper in the parent chain is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => write(acc, mkPath('/plain/sub/f.txt'), ENC.encode('hi')))).toBe(
      'ENOTDIR',
    )
  })

  it('reports the operand, not the internal parent phrasing', async () => {
    const acc = mkAccessor()
    try {
      await write(acc, mkPath('/missing/f.txt'), ENC.encode('hi'))
      expect.unreachable()
    } catch (err) {
      expect((err as { virtualPath?: string }).virtualPath).toBe('/missing/f.txt')
      expect((err as Error).message).not.toContain('parent directory does not exist')
    }
  })
})

describe('core/ram write target is a directory', () => {
  it('writeBytes onto a directory is EISDIR and leaves the directory alone', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => write(acc, mkPath('/d'), ENC.encode('hi')))).toBe('EISDIR')
    expect(acc.store.files.has('/d')).toBe(false)
    expect(acc.store.dirs.has('/d')).toBe(true)
  })

  it('an append onto a directory is EISDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => write(acc, mkPath('/d'), ENC.encode('hi'), true))).toBe('EISDIR')
    expect(acc.store.files.has('/d')).toBe(false)
  })

  it('truncate onto a directory is EISDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => truncate(acc, mkPath('/d'), 0))).toBe('EISDIR')
    expect(acc.store.files.has('/d')).toBe(false)
  })
})

describe('core/ram create destination parents', () => {
  it('a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => create(acc, mkPath('/missing/f.txt')))).toBe('ENOENT')
    expect(acc.store.files.has('/missing/f.txt')).toBe(false)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => create(acc, mkPath('/plain/f.txt')))).toBe('ENOTDIR')
  })

  it('into an existing directory is allowed', async () => {
    const acc = mkAccessor()
    await create(acc, mkPath('/d/f.txt'))
    expect(acc.store.files.get('/d/f.txt')?.byteLength).toBe(0)
  })
})

describe('core/ram append destination parents', () => {
  it('a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => write(acc, mkPath('/missing/f.txt'), ENC.encode('hi'), true))).toBe(
      'ENOENT',
    )
    expect(acc.store.files.has('/missing/f.txt')).toBe(false)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => write(acc, mkPath('/plain/f.txt'), ENC.encode('hi'), true))).toBe(
      'ENOTDIR',
    )
  })

  it('appends into an existing directory', async () => {
    const acc = mkAccessor()
    await write(acc, mkPath('/d/f.txt'), ENC.encode('a'), true)
    await write(acc, mkPath('/d/f.txt'), ENC.encode('b'), true)
    expect(new TextDecoder().decode(acc.store.files.get('/d/f.txt'))).toBe('ab')
  })
})

describe('core/ram mkdir destination parents', () => {
  // The non-parents branch used to throw a bare Error, so the failure was
  // not even classified as a filesystem error and could not be reported
  // with a GNU strerror.
  it('a missing parent is ENOENT and leaves no orphan', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => mkdir(acc, mkPath('/missing/sub')))).toBe('ENOENT')
    expect(acc.store.dirs.has('/missing/sub')).toBe(false)
  })

  it('a parent that is a plain file is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => mkdir(acc, mkPath('/plain/sub')))).toBe('ENOTDIR')
    expect(acc.store.dirs.has('/plain/sub')).toBe(false)
  })

  it('a plain file deeper in the parent chain is ENOTDIR', async () => {
    const acc = mkAccessor()
    expect(await codeOf(() => mkdir(acc, mkPath('/plain/sub/deeper')))).toBe('ENOTDIR')
  })

  it('into an existing directory is allowed', async () => {
    const acc = mkAccessor()
    await mkdir(acc, mkPath('/d/sub'))
    expect(acc.store.dirs.has('/d/sub')).toBe(true)
  })
})

const DEC = new TextDecoder()
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, STREAM_PUBLISH_SECONDS * 3000))

async function* quiet(chunks: string[], hold: Promise<void>): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield ENC.encode(chunk)
  await hold
}

async function* chunksOf(...chunks: string[]): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  for (const chunk of chunks) yield ENC.encode(chunk)
}

async function* broken(): AsyncIterable<Uint8Array> {
  yield ENC.encode('kept\n')
  await Promise.resolve()
  throw new Error('source gone')
}

describe('streamed write', () => {
  // A writer that goes quiet still shows what it wrote within the publish
  // interval, so a reader watches a slow program's log grow.
  it("shows a quiet writer's bytes", async () => {
    const accessor = mkAccessor()
    let release = (): void => undefined
    const hold = new Promise<void>((resolve) => (release = resolve))
    const writing = write(accessor, mkPath('/log'), quiet(['a\n', 'b\n'], hold))
    await settle()
    expect(DEC.decode(accessor.store.files.get('/log'))).toBe('a\nb\n')
    release()
    await writing
    expect(DEC.decode(accessor.store.files.get('/log'))).toBe('a\nb\n')
  })

  // A streamed append lands after what another appender added meanwhile.
  it("keeps another appender's bytes", async () => {
    const accessor = mkAccessor()
    accessor.store.files.set('/log', ENC.encode('start\n'))
    let release = (): void => undefined
    const hold = new Promise<void>((resolve) => (release = resolve))
    const writing = write(accessor, mkPath('/log'), quiet(['mine\n'], hold), true)
    await settle()
    await write(accessor, mkPath('/log'), ENC.encode('theirs\n'), true)
    release()
    await writing
    expect(DEC.decode(accessor.store.files.get('/log'))).toBe('start\nmine\ntheirs\n')
  })

  // An atomic write shows nothing until it ends whole.
  it('lands an atomic write at its end', async () => {
    const accessor = mkAccessor()
    accessor.store.files.set('/f', ENC.encode('old'))
    let release = (): void => undefined
    const hold = new Promise<void>((resolve) => (release = resolve))
    const writing = write(accessor, mkPath('/f'), quiet(['new'], hold), false, undefined, true)
    await settle()
    expect(DEC.decode(accessor.store.files.get('/f'))).toBe('old')
    release()
    await writing
    expect(DEC.decode(accessor.store.files.get('/f'))).toBe('new')
  })

  // A replacement writes at its own position, as an open file's offset keeps
  // it: a truncation behind its back leaves a hole up to where it writes next.
  it('keeps a replacement at its own position', async () => {
    const accessor = mkAccessor()
    let next = (): void => undefined
    const second = new Promise<void>((resolve) => (next = resolve))
    async function* source(): AsyncIterable<Uint8Array> {
      yield ENC.encode('a\n')
      await second
      yield ENC.encode('b\n')
    }
    const writing = write(accessor, mkPath('/f'), source())
    await settle()
    expect(DEC.decode(accessor.store.files.get('/f'))).toBe('a\n')
    accessor.store.files.set('/f', new Uint8Array())
    next()
    await writing
    expect(DEC.decode(accessor.store.files.get('/f'))).toBe('\0\0b\n')
  })

  // An append that brings nothing leaves an existing file as it was, its
  // modification time included (`true >> f`), and creates a missing one.
  it('leaves a file alone for an empty append', async () => {
    const accessor = mkAccessor()
    accessor.store.files.set('/f', ENC.encode('kept'))
    accessor.store.modified.set('/f', '2020-01-01T00:00:00Z')
    await write(accessor, mkPath('/f'), chunksOf(), true)
    expect(DEC.decode(accessor.store.files.get('/f'))).toBe('kept')
    expect(accessor.store.modified.get('/f')).toBe('2020-01-01T00:00:00Z')
    await write(accessor, mkPath('/new'), chunksOf(), true)
    expect(accessor.store.files.get('/new')?.byteLength).toBe(0)
  })

  // A stream that fails keeps what it had delivered, as a disk file does.
  it('keeps what arrived before the stream failed', async () => {
    const accessor = mkAccessor()
    await expect(write(accessor, mkPath('/f'), broken())).rejects.toThrow('source gone')
    expect(DEC.decode(accessor.store.files.get('/f'))).toBe('kept\n')
  })
})

describe('core/ram write of bytes', () => {
  it('checks and stores in one step, so a racing mkdir finds the file', async () => {
    const accessor = mkAccessor()
    const writing = write(accessor, mkPath('/race'), ENC.encode('x'))
    const making = codeOf(() => mkdir(accessor, mkPath('/race')))
    await writing
    expect(await making).toBe('EEXIST')
    expect(accessor.store.dirs.has('/race')).toBe(false)
  })

  it('refuses a write into an input pipe, an empty one too', async () => {
    const files = new DevFiles('owner')
    const [path] = files.allocateInput(new DevicePipe(true))
    const accessor = new RAMAccessor(new DevStore(files) as unknown as RAMStore)
    for (const data of [new Uint8Array(), ENC.encode('x')]) {
      expect(await codeOf(() => write(accessor, mkPath(path.slice(4)), data))).toBe('EBADF')
    }
  })
})

async function* streamOf(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) {
    await Promise.resolve()
    yield ENC.encode(part)
  }
}

describe('core/ram write against a capacity', () => {
  it('charges what a bytes write adds', async () => {
    const [acc, usage] = capped(10, { '/old': '123' })
    await write(acc, ramPath('/f'), ENC.encode('1234'))
    await write(acc, ramPath('/f'), ENC.encode('12'), true)
    expect([usage.used, tableBytes(acc)]).toEqual([9, 9])
  })

  it('leaves the table as it was when a bytes write is refused', async () => {
    const [acc, usage] = capped(10, { '/f': '12345678' })
    expect(await codeOf(() => write(acc, ramPath('/g'), ENC.encode('123')))).toBe('EDQUOT')
    expect(acc.store.files.has('/g')).toBe(false)
    expect([usage.used, tableBytes(acc)]).toEqual([8, 8])
  })

  it('passes an overwrite that shrinks over the cap', async () => {
    const [acc, usage] = capped(5, { '/f': '1234567890' })
    await write(acc, ramPath('/f'), ENC.encode('123456789'))
    expect(await codeOf(() => write(acc, ramPath('/f'), ENC.encode('1'), true))).toBe('EDQUOT')
    expect([usage.used, tableBytes(acc)]).toEqual([9, 9])
  })

  it('charges an atomic stream its growth once', async () => {
    const [acc, usage] = capped(10, { '/f': '12345678' })
    await write(acc, ramPath('/f'), streamOf('12345', '6789'), false, undefined, true)
    expect([usage.used, tableBytes(acc)]).toEqual([9, 9])
  })

  it('keeps the chunks before a refused one', async () => {
    const [acc, usage] = capped(10)
    expect(await codeOf(() => write(acc, ramPath('/s'), streamOf('1234', '5678', '9abc')))).toBe(
      'EDQUOT',
    )
    expect(new TextDecoder().decode(acc.store.files.get('/s'))).toBe('12345678')
    expect([usage.used, usage.pending]).toEqual([8, 0])
  })

  it('counts the change a splice made', async () => {
    const [acc, usage] = capped(100)
    let go!: () => void
    const held = new Promise<void>((resolve) => (go = resolve))
    async function* source(): AsyncIterable<Uint8Array> {
      yield ENC.encode('aaaa')
      await held
      yield ENC.encode('bb')
    }
    const writing = write(acc, ramPath('/s'), source())
    await settle()
    await write(acc, ramPath('/s'), ENC.encode('xxxxxxxx'))
    go()
    await writing
    expect(new TextDecoder().decode(acc.store.files.get('/s'))).toBe('xxxxbbxx')
    expect([usage.used, usage.pending, tableBytes(acc)]).toEqual([8, 0, 8])
  })

  it('holds nothing after a publish fails to join its chunks', async () => {
    const [acc, usage] = capped(10)
    const unjoinable = {
      byteLength: 4,
      subarray(): unknown {
        return unjoinable
      },
      get length(): number {
        throw new Error('cannot join')
      },
    } as unknown as Uint8Array
    async function* source(): AsyncIterable<Uint8Array> {
      yield ENC.encode('1234')
      await Promise.resolve()
      yield unjoinable
    }
    await expect(write(acc, ramPath('/s'), source())).rejects.toThrow('cannot join')
    expect([usage.used, usage.pending]).toEqual([0, 0])
    await write(acc, ramPath('/t'), ENC.encode('x'.repeat(10)))
  })

  it.each([true, false])(
    'fails the write when a timer publish fails (more after: %s)',
    async (more) => {
      const [acc, usage] = capped(100)
      const unjoinable = {
        byteLength: 4,
        subarray(): unknown {
          return unjoinable
        },
        get length(): number {
          throw new Error('cannot join')
        },
      } as unknown as Uint8Array
      async function* source(): AsyncIterable<Uint8Array> {
        yield ENC.encode('1234')
        yield unjoinable
        await settle()
        if (more) yield ENC.encode('9999')
      }
      await expect(write(acc, ramPath('/s'), source())).rejects.toThrow('cannot join')
      expect([acc.store.files.get('/s')?.byteLength, usage.used, usage.pending]).toEqual([0, 0, 0])
    },
  )

  it('pads a shortened stream, counted but not admitted', async () => {
    const [acc, usage] = capped(5)
    let go!: () => void
    const held = new Promise<void>((resolve) => (go = resolve))
    async function* source(): AsyncIterable<Uint8Array> {
      yield ENC.encode('aaaa')
      await held
      yield ENC.encode('b')
    }
    const writing = write(acc, ramPath('/s'), source())
    await settle()
    await unlink(acc, ramPath('/s'))
    go()
    await writing
    expect([...(acc.store.files.get('/s') ?? [])]).toEqual([0, 0, 0, 0, 98])
    expect([usage.used, tableBytes(acc)]).toEqual([5, 5])
    expect(await codeOf(() => write(acc, ramPath('/t'), ENC.encode('1')))).toBe('EDQUOT')
  })

  it('gives back the old bytes before a replacing stream lands', async () => {
    const [acc, usage] = capped(10, { '/s': '12345678' })
    await write(acc, ramPath('/s'), streamOf('abc', 'def'))
    expect(new TextDecoder().decode(acc.store.files.get('/s'))).toBe('abcdef')
    expect([usage.used, usage.pending]).toEqual([6, 0])
  })
})
