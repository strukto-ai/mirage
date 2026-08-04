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
import { lastOf, scanOptions } from './getopt.ts'

// Mirrors python/tests/workspace/executor/builtins/test_getopt.py.

describe('scanOptions', () => {
  it('keeps letters in typed order, repeats included', () => {
    const scan = scanOptions(['-a', '-tp', '-t', 'cd'], 'afptP')
    expect(scan.letters).toEqual(['a', 't', 'p', 't'])
    expect(scan.operands).toEqual(['cd'])
    expect(scan.bad).toBeNull()
  })

  it('is non-permuting', () => {
    const scan = scanOptions(['-a', 'cd', '-t'], 'at')
    expect(scan.letters).toEqual(['a'])
    expect(scan.operands).toEqual(['cd', '-t'])
  })

  it('ends options at --', () => {
    const scan = scanOptions(['-a', '--', '-t'], 'at')
    expect(scan.letters).toEqual(['a'])
    expect(scan.operands).toEqual(['-t'])
  })

  it('treats a bare dash as an operand', () => {
    const scan = scanOptions(['-'], 'at')
    expect(scan.letters).toEqual([])
    expect(scan.operands).toEqual(['-'])
  })

  it('reports an unknown letter the way bash spells it', () => {
    expect(scanOptions(['-x', 'cd'], 'at').bad).toBe('-x')
  })

  it('fails a long spelling on its second dash', () => {
    // bash: `type --foo` refuses `--`, not `--foo`.
    expect(scanOptions(['--foo', 'cd'], 'afptP').bad).toBe('--')
  })

  it('scans no args to nothing', () => {
    const scan = scanOptions([], 'at')
    expect(scan.letters).toEqual([])
    expect(scan.operands).toEqual([])
    expect(scan.bad).toBeNull()
  })
})

describe('lastOf', () => {
  it('resolves a mutually exclusive group', () => {
    expect(lastOf(['t', 'p'], 'tpP')).toBe('p')
    expect(lastOf(['p', 't'], 'tpP')).toBe('t')
    expect(lastOf(['t', 'p', 't'], 'tpP')).toBe('t')
    expect(lastOf(['a'], 'tpP')).toBeNull()
    expect(lastOf([], 'vV')).toBeNull()
  })
})
