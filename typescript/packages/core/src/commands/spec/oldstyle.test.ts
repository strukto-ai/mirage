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
import { specOf } from './builtins.ts'
import { compileSpec } from './compile.ts'
import { expandOldStyle } from './oldstyle.ts'

const TAR = compileSpec(specOf('tar'))

describe('expandOldStyle', () => {
  it('turns a bools-only cluster into dashed flags', () => {
    const old = expandOldStyle(TAR, ['xz'])
    expect(old.argv).toEqual(['-x', '-z'])
    expect(old.origins).toEqual([0, 0])
    expect(old.cluster).toBe('xz')
    expect(old.needsValue).toBeNull()
  })

  it('lets a value letter pull the next word', () => {
    const old = expandOldStyle(TAR, ['xzf', 'a.tgz'])
    expect(old.argv).toEqual(['-x', '-z', '-f', 'a.tgz'])
    expect(old.origins).toEqual([0, 0, 0, 1])
  })

  it('keeps operands after the cluster arguments', () => {
    const old = expandOldStyle(TAR, ['czf', 'a.tgz', 'one.txt', 'two.txt'])
    expect(old.argv).toEqual(['-c', '-z', '-f', 'a.tgz', 'one.txt', 'two.txt'])
    expect(old.origins).toEqual([0, 0, 0, 1, 2, 3])
  })

  it('consumes words for two value letters in letter order', () => {
    const old = expandOldStyle(TAR, ['xfC', 'a.tgz', 'out', 'one.txt'])
    expect(old.argv).toEqual(['-x', '-f', 'a.tgz', '-C', 'out', 'one.txt'])
    expect(old.origins).toEqual([0, 0, 1, 0, 2, 3])
  })

  it('keeps a bool letter that follows a value letter', () => {
    // GNU: `tar cfz a.tgz f` gzips, so z is a flag and not f's value.
    const old = expandOldStyle(TAR, ['cfz', 'a.tgz', 'one.txt'])
    expect(old.argv).toEqual(['-c', '-f', 'a.tgz', '-z', 'one.txt'])
  })

  it('takes a dashed argument verbatim', () => {
    // GNU looks for an archive literally named -C here.
    const old = expandOldStyle(TAR, ['xzf', '-C', 'out'])
    expect(old.argv).toEqual(['-x', '-z', '-f', '-C', 'out'])
    expect(old.origins).toEqual([0, 0, 0, 1, 2])
  })

  it('leaves an undeclared letter as an undeclared flag token', () => {
    const old = expandOldStyle(TAR, ['xQz', 'a.tgz'])
    expect(old.argv).toEqual(['-x', '-Q', '-z', 'a.tgz'])
    expect(old.needsValue).toBeNull()
  })

  it('reports a value letter that ran off the end of the line', () => {
    expect(expandOldStyle(TAR, ['xzf']).needsValue).toBe('f')
  })

  it('reports the second value letter when only one word is left', () => {
    expect(expandOldStyle(TAR, ['cfC', 'a.tar']).needsValue).toBe('C')
  })

  it('leaves a dashed first word alone', () => {
    const old = expandOldStyle(TAR, ['-x', '-z', '-f', 'a.tgz'])
    expect(old.argv).toEqual(['-x', '-z', '-f', 'a.tgz'])
    expect(old.origins).toEqual([0, 1, 2, 3])
    expect(old.cluster).toBeNull()
  })

  it('leaves a long-option first word alone', () => {
    const old = expandOldStyle(TAR, ['--extract', '--file', 'a.tgz'])
    expect(old.argv).toEqual(['--extract', '--file', 'a.tgz'])
    expect(old.cluster).toBeNull()
  })

  it('leaves an empty argv alone', () => {
    const old = expandOldStyle(TAR, [])
    expect(old.argv).toEqual([])
    expect(old.origins).toEqual([])
    expect(old.cluster).toBeNull()
  })

  it('reads an empty first word as an empty cluster', () => {
    // GNU reads `tar ""` as a cluster with no letters and refuses for
    // want of a mode, so the word is consumed, not treated as an operand.
    const old = expandOldStyle(TAR, ['', 'one.txt'])
    expect(old.argv).toEqual(['one.txt'])
    expect(old.origins).toEqual([1])
    expect(old.cluster).toBe('')
  })
})
