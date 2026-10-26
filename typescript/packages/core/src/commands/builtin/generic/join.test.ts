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

import { describe, expect, it, vi } from 'vitest'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { PathSpec } from '../../../types.ts'
import { eisdir, enoent } from '../../../errors/fs.ts'
import { OrderCheck, join, parseFlags, type JoinFlags } from './join.ts'

type Row = [string, string, string, string, string, number, string, string]

// Each row is GNU join 9.7 (debian:stable-slim) run on files a and b; every
// string is a byte view, one character per byte. Mirrors GNU in test_join.py.
const GNU: Row[] = [
  ['v1v2', '1 a\n2 b\n3 c\n', '1 x\n3 z\n4 w\n', 'join -v1 -v2 a b', '', 0, '2 b\n4 w\n', ''],
  [
    'unsorted_task',
    'b one\na two\n',
    'a x\nb y\n',
    'join a b',
    '',
    1,
    'b one y\n',
    'join: a:2: is not sorted: a two\njoin: input is not in sorted order\n',
  ],
]

function bytes(view: string): Uint8Array {
  return Uint8Array.from(view, (ch) => ch.charCodeAt(0))
}

/** A thousand lines all keyed `k`: `k a0`, `k a1`, ... for tag `a`. */
function thousandKs(tag: string): Uint8Array {
  return bytes(Array.from({ length: 1000 }, (_, i) => `k ${tag}${String(i)}\n`).join(''))
}

/** `body` in chunks of `size` bytes, all in one buffer the source fills again for each. */
async function* reusing(body: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  const buffer = new Uint8Array(size)
  for (let at = 0; at < body.length; at += size) {
    const piece = body.subarray(at, at + size)
    buffer.set(piece)
    await Promise.resolve()
    yield buffer.subarray(0, piece.length)
  }
}

function view(raw: Uint8Array): string {
  return String.fromCharCode(...raw)
}

async function shell(
  mounts: Record<string, Record<string, string>>,
  cmd: string,
  stdin: string,
): Promise<[number, string, string]> {
  const vfs: Record<string, RAMVFS> = {}
  for (const [prefix, files] of Object.entries(mounts)) {
    const ram = new RAMVFS()
    for (const [name, body] of Object.entries(files)) ram.store.files.set(name, bytes(body))
    vfs[prefix] = ram
  }
  const ws = new Workspace(vfs, { mode: MountMode.WRITE })
  try {
    const io = await ws.shell(cmd, { stdin: stdin === '' ? null : bytes(stdin), cwd: '/data' })
    return [io.exitCode, view(io.stdout), view(io.stderr)]
  } finally {
    await ws.close()
  }
}

describe('join matches GNU', () => {
  it.each(GNU)('%s', async (_id, a, b, cmd, stdin, code, stdout, stderr) => {
    expect(await shell({ '/data/': { '/a': a, '/b': b } }, cmd, stdin)).toEqual([
      code,
      stdout,
      stderr,
    ])
  })
})

const DEFAULTS: JoinFlags = {
  keys: [0, 0],
  unpaired: [false, false],
  paired: true,
  filler: null,
  columns: [],
  autoColumns: false,
  delimiter: null,
  separator: ' ',
  foldCase: false,
  terminator: '\n',
  order: OrderCheck.WARN,
  header: false,
  files: [0, 1],
}

describe('parseFlags', () => {
  it.each<[Record<string, string | boolean>, Partial<JoinFlags>]>([
    [{}, {}],
    [
      { a: '2', v: '1' },
      { unpaired: [true, true], paired: false },
    ],
    [{ j: '3' }, { keys: [2, 2] }],
    [{ t: '' }, { delimiter: '\n', separator: ' ' }],
    [{ t: '\\0' }, { delimiter: '\0', separator: '\0' }],
    [
      { o: '0,2.3 1.1' },
      {
        columns: [
          [0, 0],
          [2, 2],
          [1, 0],
        ],
      },
    ],
    [
      { o: 'auto', zero_terminated: true },
      { autoColumns: true, terminator: '\0' },
    ],
    [{ nocheck_order: true }, { order: OrderCheck.OFF }],
  ])('%j', (flags, expected) => {
    expect(parseFlags(flags)).toEqual({ ...DEFAULTS, ...expected })
  })
})

describe('join across mounts', () => {
  it('reads every flag through the relay', async () => {
    const r = await shell(
      { '/data/': { '/a': 'B 2\nx 1\n' }, '/data2/': { '/b': 'b y\nC z\n' } },
      'join -i -j 1 -a1 -a2 -e - -o 0,1.2,2.2 --nocheck-order /data/a /data2/b',
      '',
    )
    expect(r).toEqual([0, 'B 2 y\nC - z\nx 1 -\n', ''])
  })
})

describe('parseFlags without a tape', () => {
  // A plain mapping places no operand on a tape; the operands given are read
  // after every option, as plain files.
  it.each<[Record<string, string>, string[], string[], Partial<JoinFlags>]>([
    [{}, ['a', 'b'], ['a', 'b'], {}],
    [{ j: '2' }, ['a', 'b'], [], { keys: [1, 1] }],
  ])('%j files %j', (flags, operands, argv, expected) => {
    expect(parseFlags(flags, operands, argv)).toEqual({ ...DEFAULTS, ...expected })
  })

  it.each<[Record<string, string>, string[], string[], string]>([
    [{}, ['a', 'b', 'c'], [], "join: extra operand 'c'\n"],
    [{ v: '2' }, ['x', 'a', 'b'], [], "join: extra operand 'b'\n"],
    [{}, ['a'], [], "join: missing operand after 'a'\n"],
    [{}, ['a'], ['-a1', 'a'], "join: missing operand after 'a'\n"],
  ])('%j refuses %j', (flags, operands, argv, message) => {
    expect(() => parseFlags(flags, operands, argv)).toThrow(message)
  })
})

describe('join over two large groups of one key', () => {
  it('hands on output before the last pair is printed', async () => {
    // 1,000 equal keys in each file make 1,000,000 lines.
    const files: Record<string, Uint8Array> = { '/a': thousandKs('a'), '/b': thousandKs('b') }
    const [source] = join([PathSpec.fromStrPath('/a'), PathSpec.fromStrPath('/b')], {
      read: async function* (p: PathSpec): AsyncIterable<Uint8Array> {
        await Promise.resolve()
        yield files[p.virtual] ?? new Uint8Array()
      },
      stdin: null,
      flags: parseFlags({}),
    })
    const chunks = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    const first = await chunks.next()
    await chunks.return?.()
    expect(view(first.value as Uint8Array).startsWith('k a0 b0\nk a0 b1\n')).toBe(true)
    expect((first.value as Uint8Array).length).toBeLessThan(2 << 16)
  })
})

describe('join over input that stays open', () => {
  // The input stays open after its first lines, as a pipe from a producer
  // that waits for this output would.
  it.each<[string, Record<string, string | boolean>, string[], string, string, string]>([
    ['the rest of FILE1 (-a1)', { a: '1', nocheck_order: true }, ['-', '/b'], 'a 1\n', '', 'a 1\n'],
    ['the rest of FILE1 (-v1)', { v: '1' }, ['-', '/b'], 'a 1\n', '', 'a 1\n'],
    ['the rest of FILE2', { a: '2' }, ['/b', '-'], 'a 1\n', '', 'a 1\n'],
    ['an unpairable line', { a: '1' }, ['-', '/b'], '0 1\n', 'a x\n', '0 1\n'],
    ['a joined line', {}, ['-', '/b'], 'a 1\nb 2\n', 'a x\nb y\n', 'a 1 x\n'],
  ])('hands on %s before waiting', async (_name, flags, operands, typed, other, expected) => {
    async function* live(): AsyncIterable<Uint8Array> {
      yield bytes(typed)
      await new Promise(() => undefined)
    }
    const [source] = join(
      operands.map((word) => PathSpec.fromStrPath(word)),
      {
        read: async function* (): AsyncIterable<Uint8Array> {
          await Promise.resolve()
          yield bytes(other)
        },
        stdin: live(),
        flags: parseFlags(flags),
      },
    )
    const chunks = (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
    const late = new Promise<'late'>((resolve) => {
      setTimeout(() => {
        resolve('late')
      }, 5000)
    })
    const first = await Promise.race([chunks.next(), late])
    expect(first === 'late' ? first : view(first.value as Uint8Array)).toBe(expected)
  })
})

async function* silentStdin(): AsyncIterable<Uint8Array> {
  await new Promise(() => undefined)
  yield new Uint8Array()
}

async function* unopenable(p: PathSpec): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  if (p.virtual === '/d') throw eisdir(p)
  if (p.virtual !== '-') throw enoent(p)
  yield new Uint8Array()
}

describe('join over a file it cannot read', () => {
  // Stdin is already open, so learning that the other file cannot be read
  // never waits on input that has not come.
  it.each<[string, string[], string]>([
    ['a directory', ['/d', '-'], 'join: read error: Is a directory\n'],
    ['a missing file', ['-', '/missing'], 'join: /missing: No such file or directory\n'],
  ])('reports %s without reading stdin', async (_name, operands, stderr) => {
    const [source, result] = join(
      operands.map((word) => PathSpec.fromStrPath(word)),
      { read: unopenable, stdin: silentStdin(), flags: parseFlags({}) },
    )
    const drained = (async (): Promise<string> => {
      const parts: string[] = []
      for await (const chunk of source as AsyncIterable<Uint8Array>) parts.push(view(chunk))
      return parts.join('')
    })()
    const late = new Promise<'late'>((resolve) => {
      setTimeout(() => {
        resolve('late')
      }, 5000)
    })
    const out = await Promise.race([drained, late])
    expect([out, result.exitCode, view(result.stderr as Uint8Array)]).toEqual(['', 1, stderr])
  })
})

describe('join over input in any chunking', () => {
  // The same input in one piece and one byte at a time joins alike.
  it.each<[Record<string, string | boolean>, string, string]>([
    [{ a: '1' }, 'a 1\nb 2\n\nc 3', 'a x\nc z\n'],
    [{ zero_terminated: true }, 'a 1\0b\n2\0', 'a x\0b y'],
    [{ t: ':', header: true }, 'k:h\na:1\n', 'k:g\na:x\nb:y\n'],
  ])('%j', async (flags, a, b) => {
    const run = async (size: number): Promise<[string, number, string]> => {
      const bodies: Record<string, Uint8Array> = { '/a': bytes(a), '/b': bytes(b) }
      const [source, result] = join([PathSpec.fromStrPath('/a'), PathSpec.fromStrPath('/b')], {
        read: async function* (p: PathSpec): AsyncIterable<Uint8Array> {
          await Promise.resolve()
          const body = bodies[p.virtual] ?? new Uint8Array()
          for (let at = 0; at < body.length; at += size) yield body.subarray(at, at + size)
        },
        stdin: null,
        flags: parseFlags(flags),
      })
      const parts: string[] = []
      for await (const chunk of source as AsyncIterable<Uint8Array>) parts.push(view(chunk))
      return [parts.join(''), result.exitCode, view(result.stderr as Uint8Array)]
    }
    const whole = await run(1 << 20)
    expect(whole[0]).not.toBe('')
    expect(await run(1)).toEqual(whole)
  })
})

describe('join over one long record', () => {
  it('copies the record a bounded number of times', async () => {
    // One 8 MiB record arrives in hundreds of chunks; copying what came so
    // far at each one would copy about 2 GiB.
    const size = 8 << 20
    const a = new Uint8Array(size + 3).fill(0x78)
    a.set(bytes('k '))
    a[a.length - 1] = 0x0a
    // Every copy of input bytes goes through set or slice.
    const sets = vi.spyOn(Uint8Array.prototype, 'set')
    const slices = vi.spyOn(Uint8Array.prototype, 'slice')
    let copied = 0
    try {
      const [source] = join([PathSpec.fromStrPath('/a'), PathSpec.fromStrPath('/b')], {
        read: async function* (p: PathSpec): AsyncIterable<Uint8Array> {
          await Promise.resolve()
          yield p.virtual === '/a' ? a : bytes('k y\n')
        },
        stdin: null,
        flags: parseFlags({ a: '1' }),
      })
      let out = 0
      for await (const chunk of source as AsyncIterable<Uint8Array>) out += chunk.length
      expect(out).toBe(size + 5)
      for (const [from] of sets.mock.calls) copied += from.length
      for (const result of slices.mock.results) copied += (result.value as Uint8Array).length
    } finally {
      sets.mockRestore()
      slices.mockRestore()
    }
    expect(copied).toBeLessThan(4 * size)
  })
})

describe('join over a source that reuses its buffer', () => {
  // Records cross chunk edges, so a record's start sits in memory the source
  // has filled again by the time its end arrives.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('keeps records whole in chunks of %i', async (size) => {
    const bodies: Record<string, Uint8Array> = {
      '/a': bytes('k abcdefghi\nl 1\nm 22 333 4444\nzzzzzzzzzz 5'),
      '/b': bytes('k z\nm yy\nn x\n'),
    }
    const [source, result] = join([PathSpec.fromStrPath('/a'), PathSpec.fromStrPath('/b')], {
      read: (p: PathSpec) => reusing(bodies[p.virtual] ?? new Uint8Array(), size),
      stdin: null,
      flags: parseFlags({ a: '1' }),
    })
    const parts: string[] = []
    for await (const chunk of source as AsyncIterable<Uint8Array>) parts.push(view(chunk))
    expect([parts.join(''), result.exitCode]).toEqual([
      'k abcdefghi z\nl 1\nm 22 333 4444 yy\nzzzzzzzzzz 5\n',
      0,
    ])
  })
})
