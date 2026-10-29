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

import type { CommandContext, AdmissionRules } from '../types.ts'
import { headAllowed, lineTokens } from './allow.ts'

function ctx(
  command: string,
  extra: Partial<Omit<CommandContext, 'command'>> = {},
): CommandContext {
  return { command, paths: [], argv: [], cwd: '/', ...extra }
}

describe('allow lists', () => {
  it("headAllowed answers the profile's one allow list", () => {
    const rules: AdmissionRules = { allow: ['ls', 'git log'], ask: [], deny: [] }
    // A name is allowed when it starts a pattern of the list.
    expect(headAllowed('ls', rules)).toBe(true)
    expect(headAllowed('git', rules)).toBe(true)
    expect(headAllowed('cat', rules)).toBe(false)
    expect(headAllowed('rm', rules)).toBe(false)
    // A profile without a list allows everything, and so does no profile.
    expect(headAllowed('rm', { allow: null, ask: [], deny: [{ reason: 'x' }] })).toBe(true)
    expect(headAllowed('rm', null)).toBe(true)
  })

  it('lineTokens reads the raw argv without the entry point', () => {
    expect(lineTokens(ctx('git', { argv: ['push'] }))).toEqual(['git', 'push'])
  })
})
