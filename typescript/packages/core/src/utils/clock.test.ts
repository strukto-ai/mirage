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

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { type Clock, ManualClock, SystemClock } from './clock.ts'

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cache')

const CLOCK_OWNERS = new Set(['Date', 'performance'])

const DATES_CLOCK_READS = new Set(['nowIso', 'utcDateFolder'])

const KEPT_ON_SYSTEM_CLOCK: Record<string, string> = {
  'index/listing_memo.ts performance.now':
    'the trust window and row-write times are counted per key prefix across every ' +
    'store sharing it, and those stores may hold different clocks, so they stay on ' +
    'the process monotonic clock; listing expiry already reads the store clock',
}

describe('SystemClock', () => {
  it('satisfies the Clock interface', () => {
    const clock: Clock = new SystemClock()
    expect(typeof clock.now()).toBe('number')
    expect(typeof clock.monotonic()).toBe('number')
  })

  it('now tracks the wall clock', () => {
    const before = Date.now() / 1000
    const reading = new SystemClock().now()
    const after = Date.now() / 1000
    expect(reading).toBeGreaterThanOrEqual(before)
    expect(reading).toBeLessThanOrEqual(after)
  })

  it('monotonic never decreases', () => {
    const clock = new SystemClock()
    const readings = Array.from({ length: 50 }, () => clock.monotonic())
    expect(readings).toEqual([...readings].sort((a, b) => a - b))
  })
})

describe('ManualClock', () => {
  it('satisfies the Clock interface', () => {
    const clock: Clock = new ManualClock()
    expect(clock.now()).toBe(0)
    expect(clock.monotonic()).toBe(0)
  })

  it('stands still when read', () => {
    // Reading must have no side effect: a deadline that moved every time
    // the code under test glanced at the clock would make every boundary
    // assertion depend on the number of glances.
    const clock = new ManualClock(100)
    expect(clock.now()).toBe(100)
    expect(clock.now()).toBe(100)
    expect(clock.monotonic()).toBe(0)
    expect(clock.monotonic()).toBe(0)
  })

  it('advance moves both readings', () => {
    const clock = new ManualClock(1000)
    clock.advance(30)
    expect(clock.now()).toBe(1030)
    expect(clock.monotonic()).toBe(30)
  })

  it('advance accumulates', () => {
    const clock = new ManualClock()
    clock.advance(0.5)
    clock.advance(0.25)
    expect(clock.monotonic()).toBe(0.75)
  })

  it('orders two events by advancing between them', () => {
    // The ordering case the ticking draft existed for, done explicitly.
    const clock = new ManualClock(1000)
    const first = clock.now()
    clock.advance(1)
    expect(clock.now()).toBeGreaterThan(first)
  })

  it('refuses to go backwards', () => {
    expect(() => {
      new ManualClock().advance(-1)
    }).toThrow(RangeError)
  })
})

function clockOwner(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return CLOCK_OWNERS.has(node.text) ? node.text : undefined
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'globalThis'
  ) {
    return CLOCK_OWNERS.has(node.name.text) ? node.name.text : undefined
  }
  return undefined
}

/**
 * Each local name `file` binds to a clock-reading export of the core dates module.
 *
 * @param file a parsed module.
 */
function datesClockBindings(file: ts.SourceFile): Map<string, string> {
  const bound = new Map<string, string>()
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/utils\/dates\.[jt]s$/.test(statement.moduleSpecifier.text)
    ) {
      continue
    }
    const named = statement.importClause?.namedBindings
    if (named === undefined || !ts.isNamedImports(named)) continue
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text
      if (DATES_CLOCK_READS.has(imported)) bound.set(element.name.text, imported)
    }
  }
  return bound
}

/** Every system-clock read in `source`, called or referenced. */
function clockReads(source: string): Set<string> {
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest)
  const dates = datesClockBindings(file)
  const found = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'now') {
      const owner = clockOwner(node.expression)
      if (owner !== undefined) found.add(`${owner}.now`)
    }
    if (
      ts.isNewExpression(node) &&
      clockOwner(node.expression) === 'Date' &&
      (node.arguments === undefined || node.arguments.length === 0)
    ) {
      found.add('new Date')
    }
    if (ts.isCallExpression(node)) {
      if (clockOwner(node.expression) === 'Date') found.add('Date()')
      const imported = ts.isIdentifier(node.expression)
        ? dates.get(node.expression.text)
        : undefined
      if (imported !== undefined) found.add(imported)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function cacheClockReads(): Set<string> {
  return new Set(
    readdirSync(CACHE_DIR, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .flatMap((name) => {
        const module = name.split(sep).join('/')
        const reads = clockReads(readFileSync(join(CACHE_DIR, name), 'utf8'))
        return [...reads].map((read) => `${module} ${read}`)
      }),
  )
}

describe('the cache clock seam', () => {
  it.each([
    ['Date.now()', 'Date.now'],
    ['performance.now()', 'performance.now'],
    ['new Date()', 'new Date'],
    ['new Date', 'new Date'],
    ['const read = Date.now', 'Date.now'],
    ['globalThis.performance.now()', 'performance.now'],
    ['new globalThis.Date()', 'new Date'],
    ['Date()', 'Date()'],
    ['globalThis.Date()', 'Date()'],
    ["import { nowIso } from '../utils/dates.ts'\nnowIso()", 'nowIso'],
    ["import { utcDateFolder as folder } from '../../utils/dates.js'\nfolder()", 'utcDateFolder'],
  ])('flags %j as %j', (source, expected) => {
    expect(clockReads(source)).toEqual(new Set([expected]))
  })

  it.each([
    'this.clock.now()',
    'this.clock.monotonic()',
    'new Date(this.clock.now() * 1000)',
    'new Date(bound)',
    'Date.parse(text)',
    "import { isoToEpoch } from '../utils/dates.ts'\nisoToEpoch(text)",
    "import { nowIso } from './other.ts'\nnowIso()",
    'nowIso()',
  ])('allows %j', (source) => {
    expect(clockReads(source)).toEqual(new Set())
  })

  it('no cache module reads the system clock past the injected Clock', () => {
    const offenders = [...cacheClockReads()].filter((read) => !(read in KEPT_ON_SYSTEM_CLOCK))
    expect(offenders).toEqual([])
  })

  it('every kept system-clock read is still made', () => {
    const reads = cacheClockReads()
    const stale = Object.keys(KEPT_ON_SYSTEM_CLOCK).filter((read) => !reads.has(read))
    expect(stale).toEqual([])
  })
})
