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
import { endOptionsAfterProgram } from './constants.ts'

const rewrite = (words: string[]): string[] => endOptionsAfterProgram('python3', words)

describe('endOptionsAfterProgram', () => {
  it('leaves a command with no program option untouched', () => {
    const words = ['-c', 'print(1)', '-u']
    expect(endOptionsAfterProgram('cat', words)).toEqual(words)
  })

  it('puts the marker after the payload value', () => {
    expect(rewrite(['-c', 'print(1)', '-u', 'x'])).toEqual(['-c', 'print(1)', '--', '-u', 'x'])
  })

  it('puts the marker after an attached payload value', () => {
    expect(rewrite(['-cprint(1)', '-u'])).toEqual(['-cprint(1)', '--', '-u'])
  })

  it('steps over a value option before the payload', () => {
    // -W takes a value, so `ignore` is not the first operand.
    expect(rewrite(['-W', 'ignore', '-c', 'p', 'x'])).toEqual([
      '-W',
      'ignore',
      '-c',
      'p',
      '--',
      'x',
    ])
  })

  it('adds its own marker even when the line already carries one', () => {
    // CPython stops parsing at -c and passes a later `--` through as
    // data, so the parser must eat ours and leave theirs.
    expect(rewrite(['-c', 'p', '--', '-u'])).toEqual(['-c', 'p', '--', '--', '-u'])
  })

  it('leaves a payload option after an operand to the program', () => {
    // `python3 s.py -c x` runs s.py; the -c is the script's own.
    expect(rewrite(['s.py', '-c', 'x'])).toEqual(['s.py', '-c', 'x'])
  })

  it('stops at a marker that precedes the payload', () => {
    expect(rewrite(['--', '-c', 'x'])).toEqual(['--', '-c', 'x'])
  })

  it('hands off a module the same way', () => {
    expect(rewrite(['-m', 'json.tool', '-h'])).toEqual(['-m', 'json.tool', '--', '-h'])
  })

  it('leaves a payload with no value for the parser to refuse', () => {
    // `python3 -c` must report the missing argument, not run a program
    // named `--`.
    expect(rewrite(['-c'])).toEqual(['-c'])
    expect(rewrite(['-cprint(1)'])).toEqual(['-cprint(1)'])
  })

  it('adds nothing when no words follow the value', () => {
    expect(rewrite(['-c', 'print(1)'])).toEqual(['-c', 'print(1)'])
  })

  it('hands off from inside a cluster', () => {
    // `python3 -uc 'p' -v` gives the program ['-c', '-v'] on CPython,
    // so the carrier is found by walking letters, not by prefix.
    expect(rewrite(['-uc', 'p', '-v', 'foo'])).toEqual(['-uc', 'p', '--', '-v', 'foo'])
  })

  it('hands off after a cluster carrying an attached value', () => {
    expect(rewrite(['-ucp', '-v', 'foo'])).toEqual(['-ucp', '--', '-v', 'foo'])
  })

  it('leaves a clustered payload with no value alone', () => {
    expect(rewrite(['-uc'])).toEqual(['-uc'])
  })

  it('steps over a long value option before the payload', () => {
    expect(rewrite(['--check-hash-based-pycs', 'never', '-c', 'p', '-u', 'z'])).toEqual([
      '--check-hash-based-pycs',
      'never',
      '-c',
      'p',
      '--',
      '-u',
      'z',
    ])
  })

  it('consumes only its own word for an attached long value option', () => {
    expect(rewrite(['--check-hash-based-pycs=never', '-c', 'p', '-u', 'z'])).toEqual([
      '--check-hash-based-pycs=never',
      '-c',
      'p',
      '--',
      '-u',
      'z',
    ])
  })

  it('consumes only its own word for an attached short value option', () => {
    expect(rewrite(['-Wignore', '-c', 'p', '-u', 'z'])).toEqual([
      '-Wignore',
      '-c',
      'p',
      '--',
      '-u',
      'z',
    ])
  })
})
