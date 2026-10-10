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

import { BUILTIN_GROUP, GRAMMAR_BUILTINS, GROUP_TIER } from './constants.ts'
import { BuiltinGroup, BuiltinTier, ShellBuiltin } from './types.ts'

describe('BuiltinTier', () => {
  it('names the two tiers', () => {
    expect(BuiltinTier.GRAMMAR).toBe('grammar')
    expect(BuiltinTier.TOOL).toBe('tool')
    expect(GRAMMAR_BUILTINS.has(ShellBuiltin.CD)).toBe(true)
    expect(GRAMMAR_BUILTINS.has(ShellBuiltin.PYTHON3)).toBe(false)
  })
})

describe('BuiltinGroup', () => {
  it('has one row per ShellBuiltin', () => {
    expect(new Set(BUILTIN_GROUP.keys())).toEqual(new Set(Object.values(ShellBuiltin)))
    const groups = new Set<string>(Object.values(BuiltinGroup))
    for (const g of BUILTIN_GROUP.values()) expect(groups.has(g)).toBe(true)
  })

  it('gives every group a tier and a member', () => {
    expect(new Set(GROUP_TIER.keys())).toEqual(new Set(Object.values(BuiltinGroup)))
    expect(new Set(BUILTIN_GROUP.values())).toEqual(new Set(Object.values(BuiltinGroup)))
  })

  it('derives the tier sets from the rows', () => {
    for (const [b, g] of BUILTIN_GROUP) {
      const tier = GROUP_TIER.get(g)
      expect(GRAMMAR_BUILTINS.has(b)).toBe(tier === BuiltinTier.GRAMMAR)
    }
  })

  it('files the words', () => {
    expect(BuiltinGroup.WORKING_DIRECTORY).toBe('working-directory')
    expect(BUILTIN_GROUP.get(ShellBuiltin.CD)).toBe(BuiltinGroup.WORKING_DIRECTORY)
    expect(BUILTIN_GROUP.get(ShellBuiltin.KILL)).toBe(BuiltinGroup.JOB_CONTROL)
    expect(GROUP_TIER.get(BuiltinGroup.JOB_CONTROL)).toBe(BuiltinTier.TOOL)
    expect(GROUP_TIER.get(BuiltinGroup.OUTPUT)).toBe(BuiltinTier.GRAMMAR)
  })
})
