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
import { headVisible, lineAllowed, lineTokens, nodeVisible } from './allow.ts'

const registry = { isMountRoot: () => false }

function ctx(
  command: string,
  extra: Partial<Omit<CommandContext, 'command' | 'registry'>> = {},
): CommandContext {
  return { command, paths: [], argv: [], cwd: '/', registry, ...extra }
}

describe('allow lists', () => {
  it("headVisible answers the profile's one allow list", () => {
    const rules: AdmissionRules = { allow: ['ls', 'git log'], ask: [], deny: [] }
    // A name is visible when it starts a pattern of the list.
    expect(headVisible('ls', rules)).toBe(true)
    expect(headVisible('git', rules)).toBe(true)
    expect(headVisible('cat', rules)).toBe(false)
    expect(headVisible('rm', rules)).toBe(false)
    // A profile without a list hides nothing, and neither does no profile.
    expect(headVisible('rm', { allow: null, ask: [], deny: [{ reason: 'x' }] })).toBe(true)
    expect(headVisible('rm', null)).toBe(true)
  })

  it('nodeVisible narrows a tree one verb at a time', () => {
    const rules: AdmissionRules = { allow: ['ls', 'linear issue list'], ask: [], deny: [] }
    // The head is visible because some line of it is allowed, and so is
    // every node on the way down to that line.
    expect(nodeVisible(['linear'], rules)).toBe(true)
    expect(nodeVisible(['linear', 'issue'], rules)).toBe(true)
    expect(nodeVisible(['linear', 'issue', 'list'], rules)).toBe(true)
    // A sibling of that path is not, at either depth.
    expect(nodeVisible(['linear', 'team'], rules)).toBe(false)
    expect(nodeVisible(['linear', 'issue', 'create'], rules)).toBe(false)
    // headVisible is the one-word case, and agrees.
    expect(headVisible('linear', rules)).toBe(nodeVisible(['linear'], rules))
    // A profile without a list hides no node of any tree.
    expect(nodeVisible(['linear', 'team'], null)).toBe(true)
    expect(nodeVisible(['linear', 'team'], { allow: null, ask: [], deny: [{ reason: 'x' }] })).toBe(
      true,
    )
  })

  it('lineAllowed reads the whole line and skips non-tools', () => {
    const rules: AdmissionRules = {
      allow: ['ls', 'git log', 'git status'],
      ask: [],
      deny: [],
    }
    expect(lineAllowed(ctx('ls', { argv: ['-la'], tokens: ['ls', '-la'] }), rules)).toBe(true)
    expect(lineAllowed(ctx('git', { tokens: ['git', 'log', '-1'] }), rules)).toBe(true)
    // The head is visible (some git line is allowed) but this line is
    // covered by no pattern.
    expect(lineAllowed(ctx('git', { tokens: ['git', 'push'] }), rules)).toBe(false)
    // A word that is not a tool is never refused by an allow list.
    expect(lineAllowed(ctx('cd', { tokens: ['cd', '/x'], tool: false }), rules)).toBe(true)
    // A context built without the entry point's tokens reads the raw argv.
    const raw = ctx('git', { argv: ['push'] })
    expect(lineTokens(raw)).toEqual(['git', 'push'])
    expect(lineAllowed(raw, rules)).toBe(false)
  })
})
