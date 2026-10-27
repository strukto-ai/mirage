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

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { type Clock, isSystemClock, ManualClock, SystemClock } from './clock.ts'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

// Every module that reads time and waits through the workspace Clock. A
// package is scanned whole.
const SEAMED = [
  'cache',
  'observe',
  'accessor/airtable.ts',
  'accessor/base.ts',
  'accessor/box.ts',
  'accessor/dropbox.ts',
  'accessor/google_api.ts',
  'core/api/oauth.ts',
  'core/api/rate_limit.ts',
  'core/box/client.ts',
  'core/dropbox/client.ts',
  'core/google/client.ts',
  'shell/job_table',
  'workspace/files.ts',
  'workspace/mount/mount.ts',
  'workspace/mount/registry.ts',
]

const CLOCK_OWNERS = new Set(['Date', 'performance'])

const TIMERS = new Set(['setTimeout', 'setInterval'])

// What a module may import by name from a core module that reads the clock
// or waits on it: the dates module's `nowIso`, the abort module's `sleep`.
const CLOCK_IMPORTS: Record<string, ReadonlySet<string>> = {
  dates: new Set(['nowIso']),
  abort: new Set(['sleep']),
}

const KEPT_ON_SYSTEM_CLOCK: Record<string, string> = {
  'cache/index/listing_memo.ts performance.now':
    'the trust window and row-write times are counted per key prefix across every ' +
    'store sharing it, and those stores may hold different clocks, so they stay on ' +
    'the process monotonic clock; listing expiry already reads the store clock',
  'shell/job_table/table.ts setTimeout':
    "bounds a killed job's stop with a loop timer, which fake timers already " +
    'replace; on a manual clock a clock sleep would end the bound before the job ' +
    "stops. It also paces the owner's lease, renewing it and checking another " +
    "owner's, which expires on real time in the store",
  'shell/job_table/table.ts sleep':
    'paces the retry of a failed watch, which reads the store on real time; a ' +
    "manual clock's sleep returns at once and would spin the retry",
  'shell/job_table/table.ts Date.now':
    'stamps seen_at on the process records, which a host reap compares with the start ' +
    "times ps prints, on the host's wall clock; a manual clock's time would prove " +
    "nothing about the host's processes",
  'shell/job_table/ram.ts performance.now':
    "an owner's lease is compared by every table sharing the store, and those " +
    'tables may hold different clocks, so it stays on the process monotonic ' +
    "clock, as a Redis lease expires on the server's",
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

  it('sleep waits real time', async () => {
    const started = performance.now()
    await new SystemClock().sleep(0.02)
    expect(performance.now() - started).toBeGreaterThanOrEqual(15)
  })
})

describe('isSystemClock', () => {
  it('knows a platform clock, even one from another copy of this module', () => {
    expect(isSystemClock(new SystemClock())).toBe(true)
    const copy = {
      platform: true,
      now: () => 0,
      monotonic: () => 0,
      sleep: () => Promise.resolve(),
    }
    expect(isSystemClock(copy)).toBe(true)
    expect(isSystemClock(new ManualClock())).toBe(false)
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

  it('sleep advances without waiting', async () => {
    const clock = new ManualClock(10)
    const started = performance.now()
    await clock.sleep(30)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(clock.now()).toBe(40)
    expect(clock.monotonic()).toBe(30)
  })

  it.each([0, -1, Number.NaN])('sleep of %s advances nothing', async (seconds) => {
    const clock = new ManualClock(10)
    await clock.sleep(seconds)
    expect(clock.now()).toBe(10)
    expect(clock.monotonic()).toBe(0)
  })
})

function globalName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'globalThis'
  ) {
    return node.name.text
  }
  return undefined
}

function clockOwner(node: ts.Expression): string | undefined {
  const name = globalName(node)
  return name !== undefined && CLOCK_OWNERS.has(name) ? name : undefined
}

/**
 * The clock-reading and waiting helpers `file` imports by name from the core
 * dates and abort modules, and the local names it binds those modules to as
 * a namespace, each with the helpers it reaches.
 *
 * @param file a parsed module.
 */
function clockImports(file: ts.SourceFile): {
  reads: Set<string>
  namespaces: Map<string, ReadonlySet<string>>
} {
  const reads = new Set<string>()
  const namespaces = new Map<string, ReadonlySet<string>>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const match = /utils\/(dates|abort)(\.[jt]s)?$/.exec(statement.moduleSpecifier.text)
    const helpers = match === null ? undefined : CLOCK_IMPORTS[match[1] ?? '']
    const named = statement.importClause?.namedBindings
    if (helpers === undefined || named === undefined) continue
    if (ts.isNamespaceImport(named)) {
      namespaces.set(named.name.text, helpers)
      continue
    }
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text
      if (helpers.has(imported)) reads.add(imported)
    }
  }
  return { reads, namespaces }
}

/** Every system-clock read or wait `source` imports, calls or references. */
function clockReads(source: string): Set<string> {
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const { reads: found, namespaces } = clockImports(file)
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const owner = clockOwner(node.expression)
      if (owner !== undefined && node.name.text === 'now') found.add(`${owner}.now`)
      if (globalName(node.expression) === 'AbortSignal' && node.name.text === 'timeout') {
        found.add('AbortSignal.timeout')
      }
      const helpers = ts.isIdentifier(node.expression)
        ? namespaces.get(node.expression.text)
        : undefined
      if (helpers?.has(node.name.text) === true) found.add(node.name.text)
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const name = globalName(node)
      const named = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
      if (name !== undefined && TIMERS.has(name) && !named) found.add(name)
    }
    if (
      ts.isNewExpression(node) &&
      clockOwner(node.expression) === 'Date' &&
      (node.arguments === undefined || node.arguments.length === 0)
    ) {
      found.add('new Date')
    }
    if (ts.isCallExpression(node) && clockOwner(node.expression) === 'Date') found.add('Date()')
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function seamedModules(): string[] {
  return SEAMED.flatMap((seamed) =>
    seamed.endsWith('.ts')
      ? [seamed]
      : readdirSync(join(SRC_DIR, seamed), { recursive: true, encoding: 'utf8' })
          .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
          .map((name) => `${seamed}/${name.split(sep).join('/')}`),
  )
}

function seamedClockReads(): Set<string> {
  return new Set(
    seamedModules().flatMap((module) => {
      const reads = clockReads(readFileSync(join(SRC_DIR, module), 'utf8'))
      return [...reads].map((read) => `${module} ${read}`)
    }),
  )
}

describe('the clock seam', () => {
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
    ["import { nowIso as stamp } from '../../utils/dates.js'\nstamp()", 'nowIso'],
    ['setTimeout(resolve, 10)', 'setTimeout'],
    ['globalThis.setTimeout(resolve, 10)', 'setTimeout'],
    ['const tick = setInterval', 'setInterval'],
    ["import { sleep } from '../../utils/abort.ts'\nawait sleep(10)", 'sleep'],
    ["import { sleep as wait } from '../utils/abort.js'\nawait wait(10)", 'sleep'],
    ["import * as abort from '../../utils/abort.ts'\nawait abort.sleep(10)", 'sleep'],
    ["import { sleep } from '../../utils/abort'\nawait sleep(10)", 'sleep'],
    ["import { nowIso } from '../utils/dates'\nnowIso()", 'nowIso'],
    ['AbortSignal.timeout(10)', 'AbortSignal.timeout'],
    ['globalThis.AbortSignal.timeout(10)', 'AbortSignal.timeout'],
    ["import { nowIso } from '../../utils/dates.ts'\nconst read = nowIso\nread()", 'nowIso'],
    ["import * as dates from '../../utils/dates.ts'\ndates.nowIso()", 'nowIso'],
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
    "import * as dates from '../utils/dates.ts'\ndates.isoToEpoch(text)",
    "import { nowIso } from './other.ts'\nnowIso()",
    'nowIso()',
    'await this.clock.sleep(1)',
    'await tm.clock.sleep(delay)',
    "import { utcDateFolder } from '../utils/dates.ts'\nutcDateFolder(this.nowMs())",
    "import { abortable } from '../../utils/abort.ts'\nabortable(work, signal)",
    "import * as abort from '../../utils/abort.ts'\nabort.abortable(work, signal)",
    'timers.setTimeout',
  ])('allows %j', (source) => {
    expect(clockReads(source)).toEqual(new Set())
  })

  it('no seamed module reads or waits on the system clock past the injected Clock', () => {
    const offenders = [...seamedClockReads()].filter((read) => !(read in KEPT_ON_SYSTEM_CLOCK))
    expect(offenders).toEqual([])
  })

  it('every kept system-clock read is still made', () => {
    const reads = seamedClockReads()
    const stale = Object.keys(KEPT_ON_SYSTEM_CLOCK).filter((read) => !reads.has(read))
    expect(stale).toEqual([])
  })

  it('every seamed path exists', () => {
    expect(SEAMED.filter((seamed) => !existsSync(join(SRC_DIR, seamed)))).toEqual([])
  })
})
