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

import { line, resolvedPath, trees } from '../../test-utils.ts'
import { Outcome } from '../types.ts'
import { decide, redirectRuling, sourceOf } from './decide.ts'

// Mirrors python/tests/policy/match/test_decide.py.

describe('decide', () => {
  it('allows every line under no tree', () => {
    expect(decide(line(['ls']), null).outcome).toBe(Outcome.ALLOW)
    expect(decide(line(['ls']), { trees: [] }).outcome).toBe(Outcome.ALLOW)
  })

  it('a closed root denies what it names no allow for', () => {
    const rules = trees({ '*': 'deny', cat: 'allow' })
    expect(decide(line(['cat', '/x']), rules).outcome).toBe(Outcome.ALLOW)
    const refused = decide(line(['rm', '/x']), rules)
    expect(refused.outcome).toBe(Outcome.DENY)
    expect(refused.rule?.at).toBe('/*')
    expect(refused.source).toBe('top')
  })

  it('an option tightens its command', () => {
    const rules = trees({ rm: { '-r': { decision: 'deny', reason: 'no trees' } } })
    expect(decide(line(['rm', '/x']), rules).outcome).toBe(Outcome.ALLOW)
    for (const words of [
      ['rm', '-r', '/x'],
      ['rm', '-rf', '/x'],
      ['rm', '-R', '/x'],
    ]) {
      const ruling = decide(line(words), rules)
      expect(ruling.outcome).toBe(Outcome.DENY)
      expect(ruling.rule?.reason).toBe('no trees')
      expect(ruling.rule?.at).toBe('/rm/--recursive/*')
    }
  })

  it('a mount tree reports where it was written', () => {
    const rules = trees(null, { '/a': { rm: { decision: 'deny', paths: ['b/*'] } } })
    const ruling = decide(line(['rm', '/a/b/x']), rules)
    expect(ruling.outcome).toBe(Outcome.DENY)
    expect(ruling.rule?.paths).toEqual(['/a/b/*'])
    expect(ruling.source).toBe('mounts./a')
    expect(decide(line(['rm', '/c/x']), rules).outcome).toBe(Outcome.ALLOW)
  })

  it('the top tree and the inline tree are judged apart', () => {
    const rules = trees({ rm: 'allow' }, {}, { rm: 'deny' })
    expect(decide(line(['rm', '/x']), rules).outcome).toBe(Outcome.DENY)
  })

  it('sourceOf names the section', () => {
    const rules = trees({ rm: 'deny' }, { '/a': { cp: 'deny' } })
    const top = decide(line(['rm']), rules).rule
    const inside = decide(line(['cp', '/a/x']), rules).rule
    expect(top !== null && sourceOf(top)).toBe('top')
    expect(inside !== null && sourceOf(inside)).toBe('mounts./a')
  })

  it("a redirect inside a folder meets the folder's star", () => {
    const rules = trees({ '*': 'allow' }, { '/d/keep': { '*': 'deny' } })
    const ruling = redirectRuling([resolvedPath('/d/out'), resolvedPath('/d/keep/f.txt')], rules)
    expect(ruling.outcome).toBe(Outcome.DENY)
    expect(ruling.matchedPath).toBe('/d/keep/f.txt')
    expect(ruling.source).toBe('mounts./d/keep')
    expect(redirectRuling([resolvedPath('/d/out')], rules).outcome).toBe(Outcome.ALLOW)
    const asks = trees(null, { '/d/keep': { '*': 'ask' } })
    const asked = redirectRuling([resolvedPath('/d/keep/f.txt')], asks)
    expect(asked.outcome).toBe(Outcome.ASK)
    expect(asked.asks).toHaveLength(1)
  })

  it('a redirect meets no named command of a folder', () => {
    const rules = trees(null, { '/d/keep': { cat: 'deny', echo: 'deny' } })
    expect(redirectRuling([resolvedPath('/d/keep/f.txt')], rules).outcome).toBe(Outcome.ALLOW)
  })

  it('a walk over a folder leaves it to its entries', () => {
    const rules = trees({ '*': 'allow' }, { '/d/w/keep': { '*': 'deny' } })
    const walk = line(['grep', '-r', 'x', '/d'])
    expect([walk.walks, walk.walksInto ?? []]).toEqual([true, []])
    expect(decide(walk, rules).outcome).toBe(Outcome.ALLOW)
    expect(decide({ ...walk, walksInto: ['/d/w'] }, rules).outcome).toBe(Outcome.DENY)
    expect(decide(line(['grep', '-r', 'x', '/d/w/keep/a']), rules).outcome).toBe(Outcome.DENY)
    expect(decide(line(['rm', '-r', '/d']), rules).outcome).toBe(Outcome.DENY)
  })
})
