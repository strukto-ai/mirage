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
import { SHELL_SPECS, parseShellOptions } from './shell.ts'

describe('parseShellOptions', () => {
  it('parses bool and value flags', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['-r', '-n', '2', 'wc'])
    expect(parse.flags).toEqual({ r: true, n: '2' })
    expect(parse.operands).toEqual(['wc'])
    expect(parse.invalid).toBeNull()
    expect(parse.needsValue).toBeNull()
  })

  it('parses attached value inside a cluster', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['-rn2', 'echo'])
    expect(parse.flags).toEqual({ r: true, n: '2' })
    expect(parse.operands).toEqual(['echo'])
  })

  it('parses long flag with equals', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['--max-args=3', 'wc'])
    expect(parse.flags).toEqual({ n: '3' })
    expect(parse.operands).toEqual(['wc'])
  })

  it('stops at the first operand', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['echo', '-n'])
    expect(parse.flags).toEqual({})
    expect(parse.operands).toEqual(['echo', '-n'])
  })

  it('double dash ends options', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['--', '-r', 'echo'])
    expect(parse.flags).toEqual({})
    expect(parse.operands).toEqual(['-r', 'echo'])
  })

  it('lists every option in order in given', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['-L1', '-I', '{}', '-n2', '-L3', 'echo'])
    expect(parse.given).toEqual([
      ['L', '1'],
      ['I', '{}'],
      ['n', '2'],
      ['L', '3'],
    ])
    expect(parse.flags).toEqual({ L: '3', I: '{}', n: '2' })
    expect(parse.operands).toEqual(['echo'])
  })

  it('takes an optional value only when attached', () => {
    const spec = SHELL_SPECS.xargs
    expect(parseShellOptions(spec, ['-iZ', 'echo']).flags).toEqual({ i: 'Z' })
    const bare = parseShellOptions(spec, ['-i', 'Z'])
    expect(bare.flags).toEqual({ i: true })
    expect(bare.operands).toEqual(['Z'])
    expect(parseShellOptions(spec, ['--replace=Z', 'x']).flags).toEqual({ i: 'Z' })
    const longBare = parseShellOptions(spec, ['--max-lines', '2'])
    expect(longBare.flags).toEqual({ l: true })
    expect(longBare.operands).toEqual(['2'])
    expect(parseShellOptions(spec, ['-ri']).flags).toEqual({ r: true, i: true })
  })

  it('keeps the dashes of a long value flag missing its value', () => {
    expect(parseShellOptions(SHELL_SPECS.xargs, ['--max-args']).needsValue).toBe('--max-args')
    expect(parseShellOptions(SHELL_SPECS.xargs, ['--max-p']).needsValue).toBe('--max-procs')
  })

  it('resolves an abbreviated long option', () => {
    const spec = SHELL_SPECS.xargs
    expect(parseShellOptions(spec, ['--max-a=1', 'e']).given).toEqual([['n', '1']])
    const parse = parseShellOptions(spec, ['--max-a', '1', 'e'])
    expect(parse.given).toEqual([['n', '1']])
    expect(parse.operands).toEqual(['e'])
    expect(parseShellOptions(spec, ['--hel']).given).toEqual([['help', true]])
    expect(parseShellOptions(spec, ['--rep=Z']).given).toEqual([['i', 'Z']])
    expect(parseShellOptions(SHELL_SPECS.timeout, ['--si', 'KILL']).given).toEqual([['s', 'KILL']])
  })

  it('names every candidate of an ambiguous abbreviation in order', () => {
    const spec = SHELL_SPECS.xargs
    const parse = parseShellOptions(spec, ['--max', '1'])
    expect(parse.invalid).toBe('--max')
    expect(parse.candidates).toEqual(['--max-lines', '--max-args', '--max-chars', '--max-procs'])
    expect(parseShellOptions(spec, ['--ver']).candidates).toEqual(['--verbose', '--version'])
    const empty = parseShellOptions(spec, ['--=x'])
    expect(empty.invalid).toBe('--=x')
    expect(empty.candidates.slice(0, 2)).toEqual(['--null', '--arg-file'])
    const unknown = parseShellOptions(spec, ['--bogus'])
    expect(unknown.invalid).toBe('--bogus')
    expect(unknown.candidates).toEqual([])
  })

  it('reports a value on a no-argument long option', () => {
    const spec = SHELL_SPECS.xargs
    expect(parseShellOptions(spec, ['--nu=x']).unexpectedValue).toBe('--null=x')
    expect(parseShellOptions(spec, ['--help=x']).unexpectedValue).toBe('--help=x')
  })

  it.each(['-q', '--max-args'])('preserves aliases, clusters and options before %s', (tail) => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['-0rn0', '--max-args=2', tail])
    expect(parse.given).toEqual([
      ['0', true],
      ['r', true],
      ['n', '0'],
      ['n', '2'],
    ])
    expect(parse.invalid).toBe(tail === '-q' ? 'q' : null)
    expect(parse.needsValue).toBe(tail === '--max-args' ? '--max-args' : null)
  })

  it('reports an invalid short option', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['-q', 'echo'])
    expect(parse.invalid).toBe('q')
  })

  it('reports an invalid long option', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['--bogus', 'echo'])
    expect(parse.invalid).toBe('--bogus')
  })

  it('reports a value flag with no value', () => {
    const parse = parseShellOptions(SHELL_SPECS.xargs, ['-n'])
    expect(parse.needsValue).toBe('n')
  })

  it('parses timeout long bool flag', () => {
    const parse = parseShellOptions(SHELL_SPECS.timeout, ['--preserve-status', '1', 'sleep', '3'])
    expect(parse.flags).toEqual({ p: true })
    expect(parse.operands).toEqual(['1', 'sleep', '3'])
  })

  it('parses read -r', () => {
    const parse = parseShellOptions(SHELL_SPECS.read, ['-r', 'v'])
    expect(parse.flags).toEqual({ r: true })
    expect(parse.operands).toEqual(['v'])
  })

  it('reads every short spelling of an option', () => {
    for (const word of ['-?', '-h', '--help', '--he']) {
      const parse = parseShellOptions(SHELL_SPECS.man, [word, 'ls'])
      expect([parse.flags, parse.operands]).toEqual([{ '?': true }, ['ls']])
    }
  })
})
