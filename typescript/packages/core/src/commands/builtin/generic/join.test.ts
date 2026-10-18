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
import { CHUNK_SIZE } from '../../../io/cooperative.ts'
import { materialize } from '../../../io/types.ts'
import { MountMode } from '../../../types.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { PathSpec } from '../../../types.ts'
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

function view(raw: Uint8Array): string {
  return String.fromCharCode(...raw)
}

it.each([
  ['/dir', '-'],
  ['-', '/dir'],
  ['/dir', '/dev/stdin'],
  ['/dev/stdin', '/dir'],
])('reports a directory error before reading open stdin (%j, %j)', async (first, second) => {
  async function* read(_path: PathSpec): AsyncIterable<Uint8Array> {
    yield await Promise.reject(Object.assign(new Error('directory'), { code: 'EISDIR' }))
  }
  async function* stdin(): AsyncIterable<Uint8Array> {
    yield await Promise.reject(new Error('stdin was read before reporting a directory error'))
  }
  const [output, result] = join([PathSpec.fromStrPath(first), PathSpec.fromStrPath(second)], {
    read,
    stdin: stdin(),
    flags: parseFlags({}),
  })
  expect(await materialize(output)).toEqual(new Uint8Array())
  expect(view(await materialize(result.stderr))).toBe('join: read error: Is a directory\n')
  expect(result.exitCode).toBe(1)
})

it('reports a later open error before an earlier directory read error', async () => {
  async function* read(path: PathSpec): AsyncIterable<Uint8Array> {
    yield await Promise.reject(
      Object.assign(new Error('read failed'), {
        code: path.virtual === '/dir' ? 'EISDIR' : 'ENOENT',
      }),
    )
  }
  const [output, result] = join([PathSpec.fromStrPath('/dir'), PathSpec.fromStrPath('/missing')], {
    read,
    stdin: null,
    flags: parseFlags({}),
  })
  expect(await materialize(output)).toEqual(new Uint8Array())
  expect(view(await materialize(result.stderr))).toBe('join: /missing: No such file or directory\n')
  expect(result.exitCode).toBe(1)
})

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
  const ws = new Workspace(vfs, { mode: MountMode.WRITE, shellParser: await getTestParser() })
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
    const body = (tag: string): Uint8Array =>
      bytes(Array.from({ length: 1000 }, (_, i) => `k ${tag}${String(i)}\n`).join(''))
    const files: Record<string, Uint8Array> = { '/a': body('a'), '/b': body('b') }
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
    expect((first.value as Uint8Array).length).toBeLessThan(2 * CHUNK_SIZE)
  })
})

describe('join over input that stays open', () => {
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

describe('join over input in any chunking', () => {
  it.each<[Record<string, string | boolean>, string, string]>([
    [{ a: '1' }, 'a 1\nb 2\n\nc 3', 'a x\nc z\n'],
    [{ zero_terminated: true }, 'a 1\0b\n2\0', 'a x\0b y'],
    [{ t: ':', header: true }, 'k:h\na:1\n', 'k:g\na:x\nb:y\n'],
    [{ check_order: true }, 'b 1\na 2\n', 'a x\nb y\n'],
    [{}, 'b 1\na 2\n', 'a x\nb y\n'],
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
      return [parts.join(''), result.exitCode, view(await materialize(result.stderr))]
    }
    const whole = await run(1 << 20)
    expect(whole[0] + whole[2]).not.toBe('')
    expect(await run(1)).toEqual(whole)
  })
})
