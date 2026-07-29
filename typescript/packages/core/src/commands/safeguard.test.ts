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
import { CommandSafeguard, OnExceed } from '../types.ts'
import {
  DEFAULT_COMMAND_SAFEGUARDS,
  FALLBACK_SAFEGUARD,
  resolveAcrossMounts,
  resolveSafeguard,
} from './safeguard.ts'

describe('CommandSafeguard', () => {
  it('defaults to no limit + truncate', () => {
    const sg = new CommandSafeguard()
    expect(sg.maxBytes).toBeNull()
    expect(sg.maxLines).toBeNull()
    expect(sg.onExceed).toBe(OnExceed.TRUNCATE)
  })

  it('accepts onExceed override', () => {
    const sg = new CommandSafeguard({ onExceed: OnExceed.ERROR })
    expect(sg.onExceed).toBe(OnExceed.ERROR)
  })

  it('rejects negative limits', () => {
    expect(() => new CommandSafeguard({ maxBytes: -1 })).toThrow(TypeError)
    expect(() => new CommandSafeguard({ maxLines: -5 })).toThrow(TypeError)
  })

  it('rejects non-integer limits', () => {
    expect(() => new CommandSafeguard({ maxLines: 1.5 })).toThrow(TypeError)
  })
})

describe('resolveSafeguard', () => {
  it('prefers mount override over command default', () => {
    const override = new CommandSafeguard({ maxLines: 5 })
    const cmd = new CommandSafeguard({ maxLines: 50 })
    expect(resolveSafeguard('cat', [], cmd, override)).toBe(override)
  })

  it('falls back to command default when no override', () => {
    const cmd = new CommandSafeguard({ maxLines: 50 })
    expect(resolveSafeguard('cat', [], cmd, null)).toBe(cmd)
  })

  it('falls back to central default for known names', () => {
    expect(resolveSafeguard('cat')).toBe(DEFAULT_COMMAND_SAFEGUARDS.cat)
  })

  it('returns FALLBACK_SAFEGUARD for unknown command', () => {
    expect(resolveSafeguard('nl')).toBe(FALLBACK_SAFEGUARD)
    expect(FALLBACK_SAFEGUARD.timeoutSeconds).not.toBeNull()
  })

  it('includes the same five names as Python defaults, with 2000 lines + 600s', () => {
    expect(Object.keys(DEFAULT_COMMAND_SAFEGUARDS).sort()).toEqual(
      ['cat', 'grep', 'head', 'rg', 'tail'].sort(),
    )
    for (const name of ['cat', 'grep', 'rg', 'head', 'tail']) {
      const sg = DEFAULT_COMMAND_SAFEGUARDS[name]
      expect(sg).toBeDefined()
      expect(sg?.maxLines).toBe(2000)
      expect(sg?.timeoutSeconds).toBe(600)
    }
  })
})

describe('CommandSafeguard.aggr', () => {
  it('returns null when nothing present', () => {
    expect(CommandSafeguard.aggr([null, null])).toBeNull()
  })

  it('takes the tightest positive cap/timeout and prefers ERROR', () => {
    const a = new CommandSafeguard({ maxLines: 100, timeoutSeconds: 30 })
    const b = new CommandSafeguard({ maxLines: 50, timeoutSeconds: 60, onExceed: OnExceed.ERROR })
    const merged = CommandSafeguard.aggr([a, b, null])
    expect(merged?.maxLines).toBe(50)
    expect(merged?.timeoutSeconds).toBe(30)
    expect(merged?.onExceed).toBe(OnExceed.ERROR)
  })
})

describe('resolveAcrossMounts', () => {
  it('aggregates per-mount overrides, falling back to command default', () => {
    const m1 = { commandSafeguards: new Map([['cat', new CommandSafeguard({ maxLines: 10 })]]) }
    const m2 = { commandSafeguards: new Map<string, CommandSafeguard>() }
    const merged = resolveAcrossMounts('cat', [m1, m2])
    expect(merged?.maxLines).toBe(10)
  })
})
