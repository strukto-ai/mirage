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
    expect(parse.flags).toEqual({ 'preserve-status': true })
    expect(parse.operands).toEqual(['1', 'sleep', '3'])
  })

  it('parses read -r', () => {
    const parse = parseShellOptions(SHELL_SPECS.read, ['-r', 'v'])
    expect(parse.flags).toEqual({ r: true })
    expect(parse.operands).toEqual(['v'])
  })
})
