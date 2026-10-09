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

import { SPECS, specOf } from '../../../commands/spec/index.ts'
import { PathSpec } from '../../../types.ts'
import { CommandSpec, Argument } from '../../../commands/spec/types.ts'
import { FlagView } from '../../../commands/spec/flag_view.ts'
import { optionError, parseFlags } from './flags.ts'

function path(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: '', resolved: true })
}

describe('parseFlags', () => {
  it('separates by type when there is no spec', () => {
    const p = path('/data/a.txt')
    const parsed = parseFlags([p, 'hello'], null, 'unknown', '/')
    expect(parsed.paths).toEqual([p])
    expect(parsed.texts).toEqual(['hello'])
    expect(parsed.flagKwargs).toEqual({})
  })

  it('keeps the classified PathSpec over synthesis', () => {
    const p = path('/data/a.txt')
    const parsed = parseFlags([p], SPECS.cat ?? null, 'cat', '/')
    expect(parsed.paths[0]).toBe(p)
  })

  it('keeps each spelling of one path on its own operand', () => {
    // `ls -d 2026/ lnk/` with lnk -> 2026: both operands resolve to one
    // virtual path, and a lookup keyed by that path handed the second
    // spelling to both rows.
    const first = new PathSpec({
      virtual: '/data/2026',
      directory: '/data/',
      vfsPath: '',
      resolved: true,
      rawPath: '2026/',
    })
    const second = new PathSpec({
      virtual: '/data/2026',
      directory: '/data/',
      vfsPath: '',
      resolved: true,
      rawPath: 'lnk/',
    })
    const parsed = parseFlags(['-d', first, second], SPECS.ls ?? null, 'ls', '/data')
    expect(parsed.paths[0]).toBe(first)
    expect(parsed.paths[1]).toBe(second)
  })

  it('keeps an operand after a chdir option on its own spelling', () => {
    // `tar -cf out.tar -C dir .`: the option's value and the operand resolve
    // to one path, and the operand's spelling names the members (GNU tar
    // 1.35 stores `./f.txt`, not `dir/f.txt`).
    const out = new PathSpec({
      virtual: '/data/out.tar',
      directory: '/data/',
      vfsPath: '',
      resolved: true,
      rawPath: 'out.tar',
    })
    const base = new PathSpec({
      virtual: '/data/dir',
      directory: '/data/',
      vfsPath: '',
      resolved: true,
      rawPath: 'dir',
    })
    const dot = new PathSpec({
      virtual: '/data/dir',
      directory: '/data/',
      vfsPath: '',
      resolved: true,
      rawPath: '.',
    })
    const parsed = parseFlags(['-cf', out, '-C', base, dot], SPECS.tar ?? null, 'tar', '/data')
    expect(parsed.paths[0]).toBe(dot)
  })

  it('synthesizes a word the parser normalized instead of pairing it', () => {
    // A followed link whose target climbs through `..` reaches the parse
    // as `/data/b/../a/f.txt`; the parser resolves that to `/data/a/f.txt`
    // and a keyed backend can only read the resolved spelling.
    const climbing = new PathSpec({
      virtual: '/data/b/../a/f.txt',
      directory: '/data/b/../a/',
      vfsPath: '',
      resolved: true,
      rawPath: '/data/b/link',
    })
    const parsed = parseFlags([climbing], SPECS.cat ?? null, 'cat', '/data')
    expect(parsed.paths[0]?.virtual).toBe('/data/a/f.txt')
  })

  it('synthesized paths leave the backend key to the mount', () => {
    // A spec-classified PATH operand the classifier left as text; the
    // mount stamps vfsPath at execute time (sentinel-proven in
    // both languages).
    const parsed = parseFlags(['b.txt'], SPECS.cat ?? null, 'cat', '/data')
    expect(parsed.paths.length).toBe(1)
    expect(parsed.paths[0]?.vfsPath).toBe('')
  })
})

describe('optionError scan order', () => {
  it('reports the first scan error like GNU', () => {
    const spec = new CommandSpec({
      arguments: [new Argument('--context'), new Argument('--count', { action: 'store_true' })],
    })
    const dec = new TextDecoder()
    const ambiguousFirst = parseFlags(['--c', '--bogus', 'x'], spec, 'grep', '/')
    const refusal = optionError('grep', ambiguousFirst)
    expect(refusal).not.toBeNull()
    expect(dec.decode(refusal?.[0]).startsWith("grep: option '--c' is ambiguous")).toBe(true)
    const invalidFirst = parseFlags(['--bogus', '--c', 'x'], spec, 'grep', '/')
    const flipped = optionError('grep', invalidFirst)
    expect(flipped).not.toBeNull()
    expect(dec.decode(flipped?.[0]).startsWith("grep: unrecognized option '--bogus'")).toBe(true)
  })

  it('reports a refused value before a later bad option', () => {
    // GNU stops at the first offending token whatever kind it is:
    // coreutils 9.7 `tee --output-error=bad --bogus f` names the value,
    // the reversed line names --bogus, and a value option that ran out of
    // line loses to a value refused before it.
    const dec = new TextDecoder()
    const spec = new CommandSpec({
      arguments: [
        new Argument('--mode', { choices: ['warn', 'exit'] }),
        new Argument('--count', { type: 'int' }),
        new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
      ],
    })
    const valueFirst = optionError(
      'tee',
      parseFlags(['--mode=bad', '--bogus', 'f'], spec, 'tee', '/'),
    )
    expect(dec.decode(valueFirst?.[0]).startsWith("tee: invalid argument 'bad' for '--mode'")).toBe(
      true,
    )
    const optionFirst = optionError(
      'tee',
      parseFlags(['--bogus', '--mode=bad', 'f'], spec, 'tee', '/'),
    )
    expect(dec.decode(optionFirst?.[0]).startsWith("tee: unrecognized option '--bogus'")).toBe(true)
    const trailing = optionError('tee', parseFlags(['--mode=bad', '--count'], spec, 'tee', '/'))
    expect(dec.decode(trailing?.[0]).startsWith("tee: invalid argument 'bad' for '--mode'")).toBe(
      true,
    )
    const needy = optionError('tee', parseFlags(['--mode=warn', '--count'], spec, 'tee', '/'))
    expect(dec.decode(needy?.[0])).toContain("'--count' requires an argument")
  })

  it('reports the numeric conversion before the choice list', () => {
    // Numeric-typed values before choices, argparse's order, matching
    // the walk's finishNode: a non-numeric value on a float option that
    // also declares choices refuses the conversion, not the list.
    const spec = new CommandSpec({
      arguments: [new Argument('--ratio', { type: 'float', choices: ['0.5', '1.0'] })],
    })
    const parsed = parseFlags(['--ratio', '5x', 'p'], spec, 'cmd', '/')
    const refusal = optionError('cmd', parsed)
    expect(refusal).not.toBeNull()
    expect(new TextDecoder().decode(refusal?.[0])).toContain("invalid float value: '5x'")
  })
})

// The spec-driven ARGMATCH path, end to end through the executor's
// renderer. Measured on coreutils 9.4: `tee --output-error=warn-` exits 0,
// `=w` is `ambiguous argument 'w'` and `=zzz` is `invalid argument 'zzz'`,
// over one shared candidate block. Mirrors test_flags.py.
describe('optionError — the two ARGMATCH refusals', () => {
  it('accepts an unambiguous prefix', () => {
    const parsed = parseFlags(['--output-error=warn-', '/f'], specOf('tee'), 'tee', '/')
    expect(optionError('tee', parsed)).toBeNull()
    expect(parsed.flagKwargs.output_error).toBe('warn-nopipe')
  })

  it('words an ambiguous value as GNU does', () => {
    const parsed = parseFlags(['--output-error=w', '/f'], specOf('tee'), 'tee', '/')
    const refusal = optionError('tee', parsed)
    expect(refusal).not.toBeNull()
    expect(new TextDecoder().decode(refusal?.[0])).toBe(
      "tee: ambiguous argument 'w' for '--output-error'\n" +
        'Valid arguments are:\n' +
        "  - 'warn'\n  - 'warn-nopipe'\n  - 'exit'\n  - 'exit-nopipe'\n" +
        "Try 'tee --help' for more information.\n",
    )
    expect(refusal?.[1]).toBe(1)
  })

  // The two wordings are one report, so the FIRST refused value on the LINE
  // wins whichever wording it carries. Ordering them by which list they
  // landed in would make a later invalid value outrank an earlier ambiguous
  // one, which no other report here does. numfmt declares both ARGMATCH
  // tables, so one line can carry one of each. Mirrors test_flags.py.
  it('follows line order between the two wordings', () => {
    const dec = new TextDecoder()
    const parsed = parseFlags(['--from=ie', '--to=bogus', '1'], specOf('numfmt'), 'numfmt', '/')
    const refusal = optionError('numfmt', parsed)
    expect(refusal).not.toBeNull()
    expect(
      dec.decode(refusal?.[0]).startsWith("numfmt: ambiguous argument 'ie' for '--from'\n"),
    ).toBe(true)
    const other = optionError(
      'numfmt',
      parseFlags(['--from=bogus', '--to=ie', '1'], specOf('numfmt'), 'numfmt', '/'),
    )
    expect(other).not.toBeNull()
    expect(
      dec.decode(other?.[0]).startsWith("numfmt: invalid argument 'bogus' for '--from'\n"),
    ).toBe(true)
  })

  it('differs from the invalid refusal only in the first line', () => {
    const dec = new TextDecoder()
    const ambiguous = optionError(
      'tee',
      parseFlags(['--output-error=w', '/f'], specOf('tee'), 'tee', '/'),
    )
    const invalid = optionError(
      'tee',
      parseFlags(['--output-error=zzz', '/f'], specOf('tee'), 'tee', '/'),
    )
    const ambText = dec.decode(ambiguous?.[0])
    const invText = dec.decode(invalid?.[0])
    expect(ambText.slice(ambText.indexOf('\n'))).toBe(invText.slice(invText.indexOf('\n')))
    expect(ambiguous?.[1]).toBe(1)
    expect(invalid?.[1]).toBe(1)
  })
})

describe("optionError — tar's old option style", () => {
  it('reports a missing cluster argument ahead of an undeclared letter', () => {
    // GNU tar counts the cluster's argument needs before argp validates a
    // letter, so `tar Qf` and `tar fQ` both name f.
    for (const argv of [['Qf'], ['fQ']]) {
      const parsed = parseFlags(argv, specOf('tar'), 'tar', '/')
      const refusal = optionError('tar', parsed)
      expect(refusal).not.toBeNull()
      expect(new TextDecoder().decode(refusal?.[0])).toBe(
        "tar: Old option 'f' requires an argument.\n" + "Try 'tar --help' for more information.\n",
      )
      expect(refusal?.[1]).toBe(2)
    }
  })

  it('is no refusal when the cluster has its argument', () => {
    const parsed = parseFlags(['xzf', '/data/a.tgz'], specOf('tar'), 'tar', '/')
    const refusal = optionError('tar', parsed)
    expect(refusal).toBeNull()
    expect(parsed.flagKwargs.extract).toBe(true)
    expect(parsed.flagKwargs.gzip).toBe(true)
  })
})

it('retains scalar, repeated and pair spellings without classified paths', () => {
  const spec = new CommandSpec({
    arguments: [
      new Argument(['-o', '--output'], { type: 'path' }),
      new Argument(['-I', '--include'], { action: 'append', type: 'path' }),
      new Argument('--rawfile', {
        action: 'extend',
        nargs: 2,
        type: 'path',
        valueTypes: ['str', 'path'],
      }),
    ],
  })
  const parsed = parseFlags(
    ['-o', '-', '--output=./out', '-I./same', '--include', 'same', '--rawfile', 'body', './same'],
    spec,
    'reader',
    '/data',
  )
  const fl = new FlagView(parsed.flagKwargs, spec)
  expect(fl.asPaths('output').map((p) => [p.virtual, p.rawPath])).toEqual([['/data/out', './out']])
  expect(fl.asPaths('include').map((p) => [p.virtual, p.rawPath])).toEqual([
    ['/data/same', './same'],
    ['/data/same', 'same'],
  ])
  expect(fl.asList('rawfile')[0]).toBe('body')
  expect(fl.asPaths('rawfile').map((p) => [p.virtual, p.rawPath])).toEqual([
    ['/data/same', './same'],
  ])
})

describe('an empty attached path value', () => {
  // `--file=` spells the empty name, which resolved to the cwd; its walk
  // answers ENOENT as a typed '' operand's does (GNU tar 1.35: `tar: :
  // Cannot open: No such file or directory`). Mirrors python's
  // test_an_empty_attached_path_value_names_nothing.
  it('names nothing', () => {
    const parsed = parseFlags(['--file=', '-t'], SPECS.tar ?? null, 'tar', '/data')
    const file = parsed.flagKwargs.file
    expect(file instanceof PathSpec ? file.walkError : null).toBe('ENOENT')
  })
})

it.each([
  ['store', null],
  ['store', 1],
  ['store', 2],
  ['store', 3],
  ['append', null],
  ['extend', 1],
  ['extend', 2],
] as const)(
  'keeps dots on synthesized PATH flags from argv, env and default (%s, nargs=%s)',
  (action, nargs) => {
    const spec = new CommandSpec({
      arguments: [
        new Argument(['-f', '--file'], {
          type: 'path',
          action,
          nargs,
          env: 'INPUT',
          default: 'hidden/../public',
        }),
      ],
    })
    const typed =
      nargs === null || nargs === 1
        ? ['--file=hidden/../public']
        : ['--file', ...Array.from({ length: nargs }, () => 'hidden/../public')]
    for (const [argv, env] of [
      [typed, { INPUT: 'ignored' }],
      [[], { INPUT: 'hidden/../public' }],
      [[], {}],
    ] as const) {
      const parsed = parseFlags([...argv], spec, 'reader', '/repo', env)
      const paths = new FlagView(parsed.flagKwargs, spec).asPaths('file')
      expect(paths).toHaveLength(argv.length > 0 && nargs !== null ? nargs : 1)
      expect(Array.isArray(parsed.flagKwargs.file)).toBe(
        action === 'append' || action === 'extend' || (argv.length > 0 && nargs !== null),
      )
      for (const path of paths) {
        expect(path.virtual).toBe('/repo/public')
        expect(path.rawPath).toBe('hidden/../public')
        expect(path.dotted).toBe('/repo/hidden/../public')
      }
    }
  },
)
