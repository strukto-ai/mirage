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
import { materialize, type ByteSource, type IOResult } from '../../../io/types.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'
import { eacces, enoent } from '../../../utils/errors.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { labelled, rgGeneric } from './rg.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const FILES: Record<string, string> = {
  '/a.txt': 'hello\nworld\n',
  '/sub/nested.txt': 'nested\ncontent\n',
  '/oc/x.txt': 'b1\nb22\n',
  '/ovc/abc.txt': 'abc\n',
  '/ovc/def.txt': 'def\n',
}
const DIRS = new Set(['/sub', '/oc', '/ovc'])

function spec(path: string): PathSpec {
  return new PathSpec({ virtual: path, directory: path, resolved: true, vfsPath: path.slice(1) })
}

// How the classifier hands a typed `-` over: resolved under the cwd,
// spelled as typed.
function stdinOperand(raw = '-'): PathSpec {
  const virtual = raw === '/dev/stdin' ? '/dev/stdin' : '/-'
  return new PathSpec({
    virtual,
    directory: '/',
    resolved: true,
    vfsPath: virtual.slice(1),
    rawPath: raw,
  })
}

const stat = (p: PathSpec): Promise<FileStat> => {
  if (DIRS.has(p.virtual)) {
    return Promise.resolve(new FileStat({ name: p.virtual.slice(1), type: FileType.DIRECTORY }))
  }
  return FILES[p.virtual] === undefined
    ? Promise.reject(new Error(`ENOENT: ${p.virtual}`))
    : Promise.resolve(new FileStat({ name: p.virtual.slice(1), type: FileType.FILE }))
}

const readdir = (p: PathSpec): Promise<string[]> =>
  DIRS.has(p.virtual)
    ? Promise.resolve(Object.keys(FILES).filter((f) => f.startsWith(`${p.virtual}/`)))
    : Promise.reject(new Error(`ENOTDIR: ${p.virtual}`))

async function* stream(p: PathSpec): AsyncIterable<Uint8Array> {
  await Promise.resolve()
  const content = FILES[p.virtual]
  if (content === undefined) throw new Error(`ENOENT: ${p.virtual}`)
  yield ENC.encode(content)
}

async function run(
  paths: PathSpec[],
  pattern: string,
  flags: Record<string, string | boolean | number | string[]>,
  stdin: ByteSource | null,
  read: (p: PathSpec) => AsyncIterable<Uint8Array> = stream,
): Promise<[string, number]> {
  const opts = { stdin, flags, filetypeFns: null, cwd: '/' } as unknown as CommandOpts
  const [out, io] = (await rgGeneric(paths, [pattern], opts, stat, readdir, read)) as [
    ByteSource,
    IOResult,
  ]
  const text = DEC.decode(await materialize(out))
  return [text, io.exitCode]
}

// eslint-disable-next-line @typescript-eslint/require-await
async function* pipeThatGoesOn(first: string): AsyncIterable<Uint8Array> {
  yield ENC.encode(first)
  throw new Error('read past the answer')
}

describe('rgGeneric - operand', () => {
  it('reads stdin once when named twice', async () => {
    // Both operands read one cursor: the second finds it drained.
    const paths = [stdinOperand(), stdinOperand()]
    expect(await run(paths, 'b', {}, ENC.encode('b\n'))).toEqual(['<stdin>:b\n', 0])
    expect(await run(paths, 'z', { files_without_match: true }, ENC.encode('b\n'))).toEqual([
      '<stdin>\n<stdin>\n',
      0,
    ])
  })

  it('names stdin in a listing', async () => {
    const paths = [stdinOperand()]
    expect(await run(paths, 'b', { files_with_matches: true }, ENC.encode('b\n'))).toEqual([
      '<stdin>\n',
      0,
    ])
    expect(await run(paths, 'b', { files_without_match: true }, ENC.encode('b\n'))).toEqual(['', 1])
  })

  it('reads /dev/stdin under its own name', async () => {
    // ripgrep opens /dev/stdin as the path it is, so a label names it.
    const paths = [stdinOperand('/dev/stdin'), spec('/a.txt')]
    expect(await run(paths, 'world', {}, ENC.encode('world\n'))).toEqual([
      '/dev/stdin:world\n/a.txt:world\n',
      0,
    ])
  })
})

// A listing is settled by the first selected line and -m once its last
// selected line (and that line's trailing context) is out, so a source that
// goes on is never read past the answer: `-` is a typed stdin operand. A file
// is read a whole first buffer at a time, as ripgrep reads one, so the file
// row serves one before it goes on.
it.each([
  ['stdin', [], { files_without_match: true }, '', 1],
  ['stdin', ['-'], { files_with_matches: true }, '<stdin>\n', 0],
  ['stdin', ['-'], { files_without_match: true }, '', 1],
  ['stdin', ['-'], { max_count: '1', context: '1' }, 'a\nb\nc\n', 0],
  ['stdin', ['-'], { max_count: '1', type: ['py'] }, 'b\n', 0],
  ['stdin', ['-', '/a.txt'], { max_count: '1' }, '<stdin>:b\n', 0],
  ['stdin', [], { files_with_matches: true }, '<stdin>\n', 0],
  ['stdin', [], { max_count: '1', context: '1' }, 'a\nb\nc\n', 0],
  ['stdin', [], { max_count: '1', with_filename: true }, '<stdin>:b\n', 0],
  ['file', ['/a.txt'], { max_count: '1', with_filename: true }, '/a.txt:b\n', 0],
])('stops reading %s at the answer: %j %j', async (source, paths, flags, want, code) => {
  const operands = paths.map((p) => (p === '-' ? stdinOperand() : spec(p)))
  const pipe = pipeThatGoesOn('a\nb\nc\n' + (source === 'file' ? 'd\n'.repeat(32768) : ''))
  const result =
    source === 'stdin'
      ? await run(operands, 'b', flags, pipe)
      : await run(operands, 'b', flags, null, () => pipe)
  expect(result).toEqual([want, code])
})

// ripgrep 14.1.1's -o: a selected line with no match (an inverted selection)
// and a context line print whole, and -c counts matches. GNU grep -o prints
// nothing for the first two and counts lines.
describe('rgGeneric - only matching', () => {
  const specs = (paths: readonly string[]): PathSpec[] => paths.map(spec)

  it.each([
    [[], 'b1\nb22\n', '3\n'],
    [['/oc'], null, '/oc/x.txt:3\n'],
  ] as const)('-c counts matches, not lines, from %j', async (paths, stdin, want) => {
    const input = stdin === null ? null : ENC.encode(stdin)
    expect(await run(specs(paths), '[0-9]', { only_matching: true, count: true }, input)).toEqual([
      want,
      0,
    ])
  })

  it.each([
    [[], 'abc\n', '', 1],
    [['/ovc'], null, '/ovc/def.txt:0\n', 0],
  ] as const)(
    '-v -c lists an input that selected with no match, from %j',
    async (paths, stdin, want, code) => {
      const input = stdin === null ? null : ENC.encode(stdin)
      expect(
        await run(
          specs(paths),
          'abc',
          { only_matching: true, invert_match: true, count: true },
          input,
        ),
      ).toEqual([want, code])
    },
  )
})

// ripgrep 14.1.1 names a path it could not read the way the line spelled it:
// `cd /data && rg hit sub nope` reports `nope`, as it prints `sub/ok.txt:hit`.
describe('rgGeneric - unreadable paths are named as typed', () => {
  const files: Record<string, string> = { '/d/sub/locked.txt': 'hit\n', '/d/sub/ok.txt': 'hit\n' }
  const typed = (virtual: string, raw: string): PathSpec =>
    new PathSpec({
      virtual,
      directory: virtual,
      resolved: true,
      vfsPath: virtual.slice(1),
      rawPath: raw,
    })
  const statOf = (p: PathSpec): Promise<FileStat> => {
    if (p.virtual === '/d/sub') {
      return Promise.resolve(new FileStat({ name: 'sub', type: FileType.DIRECTORY }))
    }
    return files[p.virtual] === undefined
      ? Promise.reject(enoent(p.virtual))
      : Promise.resolve(new FileStat({ name: p.virtual.slice(1), type: FileType.FILE }))
  }
  const readdirOf = (p: PathSpec): Promise<string[]> =>
    p.virtual === '/d/sub' ? Promise.resolve(Object.keys(files)) : Promise.reject(enoent(p.virtual))
  async function* streamOf(p: PathSpec): AsyncIterable<Uint8Array> {
    await Promise.resolve()
    if (p.virtual === '/d/sub/locked.txt') throw eacces(p.virtual)
    const content = files[p.virtual]
    if (content === undefined) throw enoent(p.virtual)
    yield ENC.encode(content)
  }
  async function runTyped(
    paths: PathSpec[],
    flags: Readonly<Record<string, string | boolean | readonly string[]>>,
  ): Promise<[string, string, number]> {
    const opts = { stdin: null, flags, filetypeFns: null, cwd: '/d' } as unknown as CommandOpts
    const [out, io] = (await rgGeneric(paths, ['hit'], opts, statOf, readdirOf, streamOf)) as [
      ByteSource,
      IOResult,
    ]
    return [
      DEC.decode(await materialize(out)),
      DEC.decode(await materialize(io.stderr)),
      io.exitCode,
    ]
  }
  it('names a walked file it could not read', async () => {
    expect(await runTyped([typed('/d/sub', 'sub')], {})).toEqual([
      'sub/ok.txt:hit\n',
      'rg: sub/locked.txt: Permission denied (os error 13)\n',
      2,
    ])
  })
})

describe('rgGeneric - an operand the walk refused', () => {
  function walkRefused(virtual: string, rawPath: string, walkError: 'ENOENT' | 'ELOOP'): PathSpec {
    return new PathSpec({
      virtual,
      directory: virtual,
      resolved: true,
      vfsPath: virtual.slice(1),
      rawPath,
      walkError,
    })
  }
  async function runAll(paths: PathSpec[]): Promise<[string, string, number]> {
    const opts = {
      stdin: null,
      flags: {},
      filetypeFns: null,
      cwd: '/sub',
    } as unknown as CommandOpts
    const [out, io] = (await rgGeneric(paths, ['o'], opts, stat, readdir, stream)) as [
      ByteSource,
      IOResult,
    ]
    return [
      DEC.decode(await materialize(out)),
      DEC.decode(await materialize(io.stderr)),
      io.exitCode,
    ]
  }

  it.each([
    [
      'the empty name',
      walkRefused('/sub', '', 'ENOENT'),
      'rg: : IO error for operation on : No such file or directory (os error 2)\n',
    ],
    [
      'a link loop',
      walkRefused('/lp1', 'lp1', 'ELOOP'),
      'rg: lp1: IO error for operation on lp1: Too many levels of symbolic links (os error 40)\n',
    ],
  ] as const)('refuses %s by name', async (_, operand, message) => {
    // ripgrep 14.1.1: `rg o ''` and `rg o lp1` (a loop) refuse the operand by
    // name with exit 2. The empty name's `virtual` is the cwd it joined onto,
    // which must not be walked. Beside another operand the parallel walker
    // names it once.
    expect(await runAll([operand])).toEqual(['', message, 2])
    expect(await runAll([spec('/a.txt'), operand])).toEqual([
      '/a.txt:hello\n/a.txt:world\n',
      message.replace(/IO error for operation on [^:]*: /, ''),
      2,
    ])
  })

  it('refuses a lone operand it may not read in the searcher voice', async () => {
    // ripgrep 14.1.1 opens a lone file operand after the stat said it is one,
    // so a file it may not read is `rg: locked.txt: Permission denied (os
    // error 13)`, exit 2, not the shared handler's exit 1.
    const opts = { stdin: null, flags: {}, filetypeFns: null, cwd: '/' } as unknown as CommandOpts
    const typedLocked = new PathSpec({
      virtual: '/a.txt',
      directory: '/',
      resolved: true,
      vfsPath: 'a.txt',
      rawPath: 'locked.txt',
    })
    // eslint-disable-next-line require-yield
    async function* denied(): AsyncIterable<Uint8Array> {
      await Promise.resolve()
      throw eacces('/a.txt')
    }
    const [out, io] = (await rgGeneric([typedLocked], ['o'], opts, stat, readdir, denied)) as [
      ByteSource,
      IOResult,
    ]
    expect(DEC.decode(await materialize(out))).toBe('')
    expect(DEC.decode(await materialize(io.stderr))).toBe(
      'rg: locked.txt: Permission denied (os error 13)\n',
    )
    expect(io.exitCode).toBe(2)
  })
})

describe('labelled', () => {
  const base: CommandOpts = { stdin: null, flags: {}, filetypeFns: null, cwd: '/' }

  it('asks for the filename a walk would have printed', () => {
    expect(labelled(base).flags).toEqual({ with_filename: true })
  })

  it('lets -I win', () => {
    const opts = { ...base, flags: { no_filename: true } }
    expect(labelled(opts)).toBe(opts)
  })
})

// Run `line` in /data, where s holds f, t holds g and a.txt says hello and
// world, beside a read-only /ro holding f, as ripgrep 14.1.1 was pinned.
async function walked(line: string): Promise<[string, string, number]> {
  const ro = new RAMVFS()
  const seed = new Workspace(
    { '/ro/': ro },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  await seed.shell("printf 'ro\\n' > /ro/f")
  const ws = new Workspace(
    { '/data/': new RAMVFS(), '/ro/': [ro, MountMode.READ] },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  try {
    await ws.shell(
      "cd /data && mkdir s t && printf 'hello\\nworld\\n' > a.txt && printf o > s/f && printf o > t/g",
    )
    const io = await ws.shell(`cd /data && ${line}`)
    const dec = new TextDecoder()
    return [dec.decode(io.stdout), dec.decode(io.stderr), io.exitCode]
  } finally {
    await ws.close()
    await seed.close()
  }
}

const AL = 'ln -s ../a.txt s/al && '
const dang = (p: string): string =>
  `rg: ${p}: IO error for operation on ${p}: No such file or directory (os error 2)\n`
const loop = (p: string): string =>
  `rg: ${p}: IO error for operation on ${p}: Too many levels of symbolic links (os error 40)\n`

describe('rg -L', () => {
  // A link the walk meets is skipped unless -L (the last of it and
  // --no-follow) says to follow it; one to a directory is descended under the
  // link's own name, onto any mount, unless --one-file-system keeps the walk
  // on the operand's.
  it.each([
    [AL + 'rg --sort path o s', 's/f:o\n', '', 0],
    [AL + 'rg --no-follow -L --sort path o s', 's/al:hello\ns/al:world\ns/f:o\n', '', 0],
    ['ln -s /ro s/rol && rg -L --sort path ro s', 's/rol/f:ro\n', '', 0],
    ['ln -s /ro s/rol && rg -L --one-file-system --files --sort path s', 's/f\n', '', 0],
    ['ln -s /ro/f s/rf && rg -L --one-file-system --files --sort path s', 's/f\ns/rf\n', '', 0],
  ])('%s', async (line, stdout, stderr, code) => {
    expect(await walked(line)).toEqual([stdout, stderr, code])
  })

  // The ignore crate follows a link before a filter sees its name, so a
  // dangling, looping or ancestor link is reported even hidden or
  // glob-excluded, each named as the walker spells it: `./x` under the
  // implicit cwd, whose matches print bare (ripgrep 14.1.1).
  it.each([
    [
      "ln -s nowhere s/.dang && rg -L -g '*.txt' o s",
      '',
      'rg: s/.dang: No such file or directory (os error 2)\n',
    ],
    [
      'ln -s lp2 s/lp1 && ln -s lp1 s/lp2 && rg -L --sort path o s',
      's/f:o\n',
      loop('s/lp1') + loop('s/lp2'),
    ],
    [
      'mkdir s/sub && ln -s .. s/sub/up && cd s && rg -L --files',
      'f\n',
      'rg: File system loop found: ./sub/up points to an ancestor ./\n',
    ],
  ])('reports what it cannot follow: %s', async (line, stdout, stderr) => {
    expect(await walked(line)).toEqual([stdout, stderr, 2])
  })

  it('keeps status 0 under -q past a dangling link', async () => {
    expect(await walked('ln -s nowhere s/dang && rg -L -q --sort path o s')).toEqual([
      '',
      dang('s/dang'),
      0,
    ])
  })
})
