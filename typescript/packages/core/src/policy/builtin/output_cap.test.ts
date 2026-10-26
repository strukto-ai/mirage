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
import { Limit, OnExceed } from '../../types.ts'
import {
  ALL_COMMANDS,
  DEFAULT_COMMAND_LIMITS,
  FALLBACK_LIMIT,
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

  it('rejects negative or infinite timeouts', () => {
    for (const seconds of [-1, Infinity, NaN]) {
      expect(() => new Limit({ timeoutSeconds: seconds })).toThrow(TypeError)
    }
  })
})

describe('resolveLimit', () => {
  it('walks profile, mount, workspace, declared, then the table', () => {
    const profile = { cat: new Limit({ maxLines: 1 }) }
    const mount = new Limit({ maxLines: 2 })
    const workspace = { cat: new Limit({ maxLines: 3 }) }
    const declared = new Limit({ maxLines: 4 })
    const lines = (
      cmd: Limit | null,
      override: Limit | null,
      ws: Record<string, Limit>,
      prof: Record<string, Limit>,
    ) => resolveLimit('cat', [], cmd, override, ws, prof)?.maxLines
    expect(lines(declared, mount, workspace, profile)).toBe(1)
    expect(lines(declared, mount, workspace, {})).toBe(2)
    expect(lines(declared, null, workspace, {})).toBe(3)
    expect(lines(declared, null, {}, {})).toBe(4)
    expect(lines(null, null, {}, {})).toBe(DEFAULT_COMMAND_LIMITS.cat?.maxLines)
    expect(lines(null, null, workspace, { head: new Limit() })).toBe(3)
  })

  it('returns FALLBACK_LIMIT for unknown command', () => {
    expect(resolveLimit('nl')).toEqual(FALLBACK_LIMIT)
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

const mountOf = (table: Record<string, Limit> = {}, walk = 1000) => ({
  commandLimits: new Map(Object.entries(table)),
  defaultLimit: new Limit({ walkLimit: walk }),
})

describe('resolveLimit across mounts', () => {
  it('aggregates per-mount overrides, falling back to command default', () => {
    const merged = resolveLimit('cat', [mountOf({ cat: new Limit({ maxLines: 10 }) }), mountOf()])
    expect(merged?.maxLines).toBe(10)
  })

  it('lets a layer naming one bound inherit the rest', () => {
    const resolved = resolveLimit('cat', [], null, null, { cat: new Limit({ maxLines: 5 }) })
    expect([resolved?.maxLines, resolved?.timeoutSeconds]).toEqual([
      5,
      DEFAULT_COMMAND_LIMITS.cat?.timeoutSeconds,
    ])
  })

  it('puts each layer\'s every-command entry below its own', () => {
    const workspace = {
      [ALL_COMMANDS]: new Limit({ timeoutSeconds: 9, walkLimit: 7 }),
      find: new Limit({ walkLimit: 50 }),
    }
    const mount = mountOf({ [ALL_COMMANDS]: new Limit({ timeoutSeconds: 5 }) })
    const find = resolveLimit('find', [mount], null, null, workspace)
    const ls = resolveLimit('ls', [mount], null, null, workspace)
    expect([find?.timeoutSeconds, find?.walkLimit]).toEqual([5, 50])
    expect([ls?.timeoutSeconds, ls?.walkLimit]).toEqual([5, 7])
  })

  it('reads the mount walk default last and keeps the tightest across mounts', () => {
    expect(resolveLimit('ls', [mountOf(), mountOf({}, -1), mountOf({}, 200)])?.walkLimit).toBe(200)
    expect(resolveLimit('ls', [mountOf({}, -1)])?.walkLimit).toBe(-1)
  })
})

describe('prototype-colliding command names', () => {
  it('falls through to the fallback instead of an Object.prototype member', () => {
    expect(resolveLimit('toString')).toEqual(FALLBACK_LIMIT)
    expect(resolveLimit('constructor')).toEqual(FALLBACK_LIMIT)
  })
})

describe('resolveProducer', () => {
  const table = (entries: Record<string, Record<string, Limit>>) => (prefix: string) =>
    Object.hasOwn(entries, prefix) ? mountOf(entries[prefix]) : null

  it('prefers the mount override over the declared bound', () => {
    const resolved = resolveProducer(
      { command: 'cat', prefixes: ['/a/'], declared: new Limit({ maxLines: 50 }) },
      table({ '/a/': { cat: new Limit({ maxLines: 4 }) } }),
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
        '/a/': { cat: new Limit({ maxLines: 9 }) },
        '/b/': { cat: new Limit({ maxLines: 3 }) },
      }),
    )
    expect(resolved?.maxLines).toBe(3)
  })

  it('an empty command has no bound', () => {
    expect(resolveProducer({ command: '', prefixes: [], declared: null }, table({}))).toBeNull()
  })
})
