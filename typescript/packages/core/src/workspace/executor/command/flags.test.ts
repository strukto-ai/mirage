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
import { registeredSpec } from '../../../commands/spec/builtins.ts'
import { PathSpec } from '../../../types.ts'
import { CommandSpec, Operand, Option } from '../../../commands/spec/types.ts'
import { optionError, parseFlags } from './flags.ts'

function path(virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, resourcePath: '', resolved: true })
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
      resourcePath: '',
      resolved: true,
      rawPath: '2026/',
    })
    const second = new PathSpec({
      virtual: '/data/2026',
      directory: '/data/',
      resourcePath: '',
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
      resourcePath: '',
      resolved: true,
      rawPath: 'out.tar',
    })
    const base = new PathSpec({
      virtual: '/data/dir',
      directory: '/data/',
      resourcePath: '',
      resolved: true,
      rawPath: 'dir',
    })
    const dot = new PathSpec({
      virtual: '/data/dir',
      directory: '/data/',
      resourcePath: '',
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
      resourcePath: '',
      resolved: true,
      rawPath: '/data/b/link',
    })
    const parsed = parseFlags([climbing], SPECS.cat ?? null, 'cat', '/data')
    expect(parsed.paths[0]?.virtual).toBe('/data/a/f.txt')
  })

  it('synthesized paths leave the backend key to the mount', () => {
    // A spec-classified PATH operand the classifier left as text; the
    // mount stamps resourcePath at execute time (sentinel-proven in
    // both languages).
    const parsed = parseFlags(['b.txt'], SPECS.cat ?? null, 'cat', '/data')
    expect(parsed.paths.length).toBe(1)
    expect(parsed.paths[0]?.resourcePath).toBe('')
  })
})

describe('optionError scan order', () => {
  it('reports the first scan error like GNU', () => {
    const spec = new CommandSpec({
      options: [new Option({ long: '--context', type: 'str' }), new Option({ long: '--count' })],
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
      options: [
        new Option({ long: '--mode', type: 'str', choices: ['warn', 'exit'] }),
        new Option({ long: '--count', type: 'int' }),
      ],
      rest: new Operand({ type: 'path' }),
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
      options: [new Option({ long: '--ratio', type: 'float', choices: ['0.5', '1.0'] })],
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
    expect(parsed.flagKwargs.x).toBe(true)
    expect(parsed.flagKwargs.z).toBe(true)
  })
})

// The parser settles whose grammar a line was read against and the door
// reads that bit, never the spelling: a mount may register its own command
// under a builtin's name (nothing refuses it), and the measured per-program
// tables describe one real program each.
describe('optionError on a borrowed builtin name', () => {
  const BORROWED = new CommandSpec({
    options: [new Option({ long: '--mode', type: 'str' })],
    rest: new Operand({ type: 'str' }),
  })
  const td = new TextDecoder()

  it("parseFlags carries the parser's builtin bit", () => {
    expect(parseFlags(['x'], registeredSpec('grep', specOf('grep')), 'grep', '/').builtin).toBe(
      true,
    )
    expect(parseFlags(['x'], specOf('grep'), 'grep', '/').builtin).toBe(true)
    expect(parseFlags(['x'], BORROWED, 'grep', '/').builtin).toBe(false)
    expect(parseFlags(['x'], null, 'grep', '/').builtin).toBe(false)
  })

  it('a borrowed name is refused like any custom command', () => {
    for (const name of ['grep', 'diff', 'python3', 'curl', 'tar']) {
      const refusal = optionError(name, parseFlags(['--bogus', 'x'], BORROWED, name, '/'))
      expect(refusal).not.toBeNull()
      if (refusal === null) throw new Error('unreachable')
      expect(td.decode(refusal[0])).toBe(
        `${name}: unrecognized option '--bogus'\nTry '${name} --help' for more information.\n`,
      )
      expect(refusal[1]).toBe(1)
    }
    expect(optionError('grep', parseFlags(['x'], specOf('grep'), 'grep', '/'))).toBeNull()
    const builtin = optionError('grep', parseFlags(['--bogus', 'x'], specOf('grep'), 'grep', '/'))
    expect(builtin?.[1]).toBe(2)
  })

  // The find exemption is the builtin's: its expression is validated by
  // parseFindExpression. A borrowed `find` has no such parser, so its
  // undeclared option is refused rather than silently dropped.
  it('a borrowed find is not exempt from option refusal', () => {
    const refusal = optionError('find', parseFlags(['--bogus', 'x'], BORROWED, 'find', '/'))
    expect(refusal).not.toBeNull()
    if (refusal === null) throw new Error('unreachable')
    expect(td.decode(refusal[0])).toMatch(/^find: unrecognized option '--bogus'\n/)
    expect(optionError('find', parseFlags(['-name', 'x'], specOf('find'), 'find', '/'))).toBeNull()
  })
})
