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
import { Limit, OnExceed, PathSpec } from '../../types.ts'
import {
  DEFAULT_COMMAND_LIMITS,
  FALLBACK_LIMIT,
  OutputCapPolicy,
  resolveAcrossMounts,
  resolveProducer,
  resolveLimit,
} from './output_cap.ts'

describe('Limit', () => {
  it('defaults to no limit + truncate', () => {
    const sg = new Limit()
    expect(sg.maxBytes).toBeNull()
    expect(sg.maxLines).toBeNull()
    expect(sg.onExceed).toBe(OnExceed.TRUNCATE)
  })

  it('accepts onExceed override', () => {
    const sg = new Limit({ onExceed: OnExceed.ERROR })
    expect(sg.onExceed).toBe(OnExceed.ERROR)
  })

  it('rejects negative limits', () => {
    expect(() => new Limit({ maxBytes: -1 })).toThrow(TypeError)
    expect(() => new Limit({ maxLines: -5 })).toThrow(TypeError)
  })

  it('rejects non-integer limits', () => {
    expect(() => new Limit({ maxLines: 1.5 })).toThrow(TypeError)
  })
})

describe('resolveLimit', () => {
  it('prefers mount override over command default', () => {
    const override = new Limit({ maxLines: 5 })
    const cmd = new Limit({ maxLines: 50 })
    expect(resolveLimit('cat', [], cmd, override)).toBe(override)
  })

  it('falls back to command default when no override', () => {
    const cmd = new Limit({ maxLines: 50 })
    expect(resolveLimit('cat', [], cmd, null)).toBe(cmd)
  })

  it('falls back to central default for known names', () => {
    expect(resolveLimit('cat')).toBe(DEFAULT_COMMAND_LIMITS.cat)
  })

  it('returns FALLBACK_LIMIT for unknown command', () => {
    expect(resolveLimit('nl')).toBe(FALLBACK_LIMIT)
    expect(FALLBACK_LIMIT.timeoutSeconds).not.toBeNull()
  })

  it('includes the same five names as Python defaults, with 2000 lines + 600s', () => {
    expect(Object.keys(DEFAULT_COMMAND_LIMITS).sort()).toEqual(
      ['cat', 'grep', 'head', 'rg', 'tail'].sort(),
    )
    for (const name of ['cat', 'grep', 'rg', 'head', 'tail']) {
      const sg = DEFAULT_COMMAND_LIMITS[name]
      expect(sg).toBeDefined()
      expect(sg?.maxLines).toBe(2000)
      expect(sg?.timeoutSeconds).toBe(600)
    }
  })
})

describe('Limit.aggr', () => {
  it('returns null when nothing present', () => {
    expect(Limit.aggr([null, null])).toBeNull()
  })

  it('takes the tightest positive cap/timeout and prefers ERROR', () => {
    const a = new Limit({ maxLines: 100, timeoutSeconds: 30 })
    const b = new Limit({ maxLines: 50, timeoutSeconds: 60, onExceed: OnExceed.ERROR })
    const merged = Limit.aggr([a, b, null])
    expect(merged?.maxLines).toBe(50)
    expect(merged?.timeoutSeconds).toBe(30)
    expect(merged?.onExceed).toBe(OnExceed.ERROR)
  })
})

describe('resolveAcrossMounts', () => {
  it('aggregates per-mount overrides, falling back to command default', () => {
    const m1 = { commandLimits: new Map([['cat', new Limit({ maxLines: 10 })]]) }
    const m2 = { commandLimits: new Map<string, Limit>() }
    const merged = resolveAcrossMounts('cat', [m1, m2])
    expect(merged?.maxLines).toBe(10)
  })
})

describe('prototype-colliding command names', () => {
  it('falls through to the fallback instead of an Object.prototype member', () => {
    const sg = resolveLimit('toString')
    expect(sg).toBe(FALLBACK_LIMIT)
    expect(resolveLimit('constructor')).toBe(FALLBACK_LIMIT)
  })
})

describe('resolveProducer', () => {
  const table = (entries: Record<string, Limit>) => (prefix: string, name: string) =>
    entries[`${prefix}|${name}`] ?? null

  it('prefers the mount override over the declared bound', () => {
    const resolved = resolveProducer(
      { command: 'cat', prefixes: ['/a/'], declared: new Limit({ maxLines: 50 }) },
      table({ '/a/|cat': new Limit({ maxLines: 4 }) }),
    )
    expect(resolved?.maxLines).toBe(4)
  })

  it('falls back to declared, then the table', () => {
    const declared = resolveProducer(
      { command: 'cat', prefixes: [], declared: new Limit({ maxLines: 50 }) },
      table({}),
    )
    expect(declared?.maxLines).toBe(50)
    const fromTable = resolveProducer({ command: 'cat', prefixes: [], declared: null }, table({}))
    expect(fromTable?.maxLines).toBe(DEFAULT_COMMAND_LIMITS.cat?.maxLines)
  })

  it('aggregates the tightest across prefixes', () => {
    const resolved = resolveProducer(
      { command: 'cat', prefixes: ['/a/', '/b/'], declared: null },
      table({
        '/a/|cat': new Limit({ maxLines: 9 }),
        '/b/|cat': new Limit({ maxLines: 3 }),
      }),
    )
    expect(resolved?.maxLines).toBe(3)
  })

  it('an empty command has no bound', () => {
    expect(resolveProducer({ command: '', prefixes: [], declared: null }, table({}))).toBeNull()
  })
})

describe('OutputCapPolicy', () => {
  it('answers postOps from the op table', () => {
    const policy = new OutputCapPolicy((prefix, name) =>
      prefix === '/a/' && name === 'read' ? new Limit({ maxBytes: 4 }) : null,
    )
    const capped = policy.postOps({
      op: 'read',
      path: new PathSpec({ virtual: '/a/x', directory: '/a', resourcePath: '' }),
      write: false,
      prefix: '/a/',
      result: null,
    })
    expect(capped).toEqual(new Limit({ maxBytes: 4 }))
    const silent = policy.postOps({
      op: 'write',
      path: new PathSpec({ virtual: '/a/x', directory: '/a', resourcePath: '' }),
      write: true,
      prefix: '/a/',
      result: null,
    })
    expect(silent).toBeNull()
  })
})
