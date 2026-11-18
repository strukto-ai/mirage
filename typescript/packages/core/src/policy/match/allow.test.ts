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

import { trees } from '../../test-utils.ts'
import type { CommandContext } from '../types.ts'
import { lineTokens, runs } from './allow.ts'

function ctx(
  command: string,
  extra: Partial<Omit<CommandContext, 'command'>> = {},
): CommandContext {
  return { command, paths: [], argv: [], cwd: '/', ...extra }
}

describe('runs', () => {
  it('runs unless a tree that holds everywhere denies every line', () => {
    expect(runs('rm', null)).toBe(true)
    const rules = trees({ '*': 'deny', ls: 'allow', git: { push: 'deny' } })
    expect(runs('ls', rules)).toBe(true)
    expect(runs('git', rules)).toBe(false)
    expect(runs('rm', rules)).toBe(false)
    expect(runs('git', trees({ git: { push: 'deny' } }))).toBe(true)
    expect(runs('cat', trees({ cat: 'deny' }))).toBe(false)
    expect(runs('cat', trees(null, { '/a': { cat: 'deny' } }))).toBe(true)
  })

  it('lineTokens reads the raw argv without the entry point', () => {
    expect(lineTokens(ctx('git', { argv: ['push'] }))).toEqual(['git', 'push'])
  })
})
