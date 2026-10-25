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
import { ManualClock, SystemClock } from './clock.ts'
import {
  type IdSource,
  SeededIdSource,
  SystemIdSource,
  newSessionId,
  newWorkspaceId,
  randomBelow,
  randomBelowBig,
  shuffle,
  uuid7,
} from './ids.ts'

// Pinned by the python twin too (tests/utils/test_ids.py): one seed draws one
// sequence on both hosts.
const SEED_42_WORDS = [825760943, 2622800619, 310231447, 2495256757]
const SEED_7_IDS = [
  '018bcfe5-6800-70e6-beb7-02bf41b04f69',
  '018bcfe5-6800-70e7-86ef-ef930baa6e99',
  '018bcfe5-6801-70f9-94f4-c83f9b431a91',
]

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

// The packages whose ids and draws come from the workspace IdSource.
const SEAMED_PACKAGES = ['cache', 'commands', 'core', 'execution', 'process', 'workspace']

const GLOBAL_DRAWS: Record<string, Set<string>> = {
  crypto: new Set(['randomUUID', 'getRandomValues']),
  Math: new Set(['random']),
}

const NODE_CRYPTO_DRAWS = new Set([
  'randomUUID',
  'getRandomValues',
  'randomBytes',
  'randomInt',
  'randomFill',
  'randomFillSync',
])

const UUID_PACKAGE_DRAWS = new Set(['v1', 'v4', 'v6', 'v7'])

const IDS_DRAWS = new Set(['uuid7', 'newWorkspaceId', 'newSessionId'])

// Every draw names one of these in its import or its call, so a module that names none
// of them is not parsed.
const DRAW_HINT = /uuid|random|Random|crypto|newSessionId|newWorkspaceId/

/** A module that draws, by the members that draw and how a draw through it is reported. */
interface DrawOwner {
  draws: ReadonlySet<string>
  report: (name: string) => string
}

const KEPT_ON_PROCESS_RANDOMNESS: Record<string, string> = {
  'core/jq/eval.ts crypto.getRandomValues':
    "the prelude's key token is drawn once per process and never reaches output; " +
    'it only has to be one no program can spell',
}

function stampOf(value: string): number {
  return parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
}

const UUID7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuid7', () => {
  it('is canonical lowercase and version 7', () => {
    expect(uuid7()).toMatch(UUID7_RE)
  })

  it('embeds the current timestamp', () => {
    const before = Date.now()
    const value = uuid7()
    const after = Date.now()
    const embedded = parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
    expect(embedded).toBeGreaterThanOrEqual(before - 10)
    expect(embedded).toBeLessThanOrEqual(after + 10)
  })

  it('orders across milliseconds', async () => {
    const first = uuid7()
    await new Promise((r) => setTimeout(r, 2))
    const second = uuid7()
    expect(first < second).toBe(true)
  })

  it('is unique', () => {
    const values = new Set(Array.from({ length: 1000 }, () => uuid7()))
    expect(values.size).toBe(1000)
  })
})

describe('id kinds', () => {
  it('share the format', () => {
    expect(newWorkspaceId()).toMatch(UUID7_RE)
    expect(newSessionId()).toMatch(UUID7_RE)
  })
})

describe('SystemIdSource', () => {
  it('satisfies the protocol', () => {
    const ids: IdSource = new SystemIdSource()
    expect(ids.uuid7()).toMatch(UUID7_RE)
    const word = ids.randomU32()
    expect(Number.isInteger(word) && word >= 0 && word < 2 ** 32).toBe(true)
  })

  it('stamps a uuid7 from its clock', () => {
    const source = new SystemIdSource(new ManualClock(1_700_000_000))
    expect(stampOf(source.uuid7())).toBe(1_700_000_000_000)
  })

  it('never waits on a frozen clock', () => {
    // Waiting for a frozen clock to tick would spin forever, so a burst
    // past the counter moves on to the next millisecond by itself.
    const source = new SystemIdSource(new ManualClock(5))
    const values = Array.from({ length: 5000 }, () => source.uuid7())
    expect(values).toEqual([...values].sort())
    expect(new Set(values).size).toBe(values.length)
    expect(stampOf(values[0] ?? '')).toBe(5000)
    expect(stampOf(values.at(-1) ?? '')).toBeGreaterThan(5000)
  })

  it('keeps its order when the clock goes back', () => {
    const clock = {
      wall: 10,
      now: () => clock.wall,
      monotonic: () => 0,
      sleep: () => Promise.resolve(),
    }
    const source = new SystemIdSource(clock)
    const first = source.uuid7()
    clock.wall = 9
    const second = source.uuid7()
    expect(first < second).toBe(true)
    expect(stampOf(second)).toBe(10_000)
  })

  it('shares the process floor with every source on the system clock', () => {
    // Callers build a throwaway source per id; ids from all of them, and from
    // uuid7() itself, still sort by when they were minted.
    const values: string[] = []
    for (let i = 0; i < 1000; i++) {
      values.push(
        new SystemIdSource().uuid7(),
        uuid7(),
        new SystemIdSource(new SystemClock()).uuid7(),
      )
    }
    expect(values).toEqual([...values].sort())
  })

  it('keeps its own floor on another clock', () => {
    // A source on a clock far ahead must not drag the process's own ids,
    // or another source's, into its future.
    new SystemIdSource(new ManualClock(4_000_000_000)).uuid7()
    expect(stampOf(uuid7())).toBeLessThanOrEqual(Date.now())
    expect(stampOf(new SystemIdSource(new ManualClock(5)).uuid7())).toBe(5000)
  })

  it('orders ids within one millisecond', () => {
    const values = Array.from({ length: 200 }, () => uuid7())
    expect(values).toEqual([...values].sort())
  })
})

describe('SeededIdSource', () => {
  it('replays its words', () => {
    const source = new SeededIdSource(42)
    expect(Array.from({ length: 4 }, () => source.randomU32())).toEqual(SEED_42_WORDS)
  })

  it('draws another sequence for another seed', () => {
    const first = new SeededIdSource(1)
    const second = new SeededIdSource(2)
    expect(Array.from({ length: 4 }, () => first.randomU32())).not.toEqual(
      Array.from({ length: 4 }, () => second.randomU32()),
    )
  })

  it('stamps a uuid7 from its clock', () => {
    const clock = new ManualClock(1_700_000_000)
    const source = new SeededIdSource(7, clock)
    const minted = [source.uuid7(), source.uuid7()]
    clock.advance(0.001)
    minted.push(source.uuid7())
    expect(minted).toEqual(SEED_7_IDS)
    for (const value of minted) expect(value).toMatch(UUID7_RE)
    expect(stampOf(minted[0] ?? '')).toBe(1_700_000_000_000)
  })

  it('depends on the seed alone without a clock', () => {
    expect(new SeededIdSource(9).uuid7()).toBe(new SeededIdSource(9).uuid7())
    expect(stampOf(new SeededIdSource(9).uuid7())).toBe(0)
  })

  // A frozen clock never ticks, so a burst past the counter has to move on by
  // itself; waiting would hang a seeded run forever.
  it('borrows a millisecond when the counter runs out', () => {
    const source = new SeededIdSource(3, new ManualClock(5))
    const values = Array.from({ length: 5000 }, () => source.uuid7())
    expect(values).toEqual([...values].sort())
    expect(new Set(values).size).toBe(values.length)
    expect(stampOf(values.at(-1) ?? '')).toBeGreaterThan(5000)
  })

  it.each([-1, 2 ** 53, 1.5])('refuses the seed %s', (seed) => {
    expect(() => new SeededIdSource(seed)).toThrow(RangeError)
  })
})

describe('randomBelow', () => {
  it('replays across word widths', () => {
    const source = new SeededIdSource(1)
    expect(randomBelow(source, 10)).toBe(0)
    expect(randomBelowBig(source, 2n ** 64n - 1n)).toBe(7093093102422396071n)
    expect(randomBelow(source, 2 ** 32)).toBe(711577048)
  })

  it('stays in bounds', () => {
    const source = new SeededIdSource(11)
    for (const limit of [1, 2, 3, 62, 2 ** 32 - 1, 2 ** 32, 2 ** 40 + 3]) {
      for (let i = 0; i < 50; i++) {
        const value = randomBelow(source, limit)
        expect(value >= 0 && value < limit).toBe(true)
      }
    }
  })

  it.each([0, -3])('refuses the empty range %s', (limit) => {
    expect(() => randomBelow(new SeededIdSource(0), limit)).toThrow(RangeError)
    expect(() => randomBelowBig(new SeededIdSource(0), BigInt(limit))).toThrow(RangeError)
  })
})

describe('shuffle', () => {
  it('replays a permutation', () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
    shuffle(new SeededIdSource(3), items)
    expect(items).toEqual([6, 2, 3, 8, 9, 0, 1, 5, 7, 4])
  })
})

function globalOwner(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text in GLOBAL_DRAWS ? node.text : undefined
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'globalThis'
  ) {
    return node.name.text in GLOBAL_DRAWS ? node.name.text : undefined
  }
  return undefined
}

/** The member name `node` reads, when it is spelled out. */
function memberName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined
}

/**
 * The module that draws behind an import specifier, if it is one.
 *
 * @param specifier the import's module specifier.
 */
function drawOwner(specifier: string): DrawOwner | undefined {
  if (/utils\/ids(\.[jt]s)?$/.test(specifier)) return { draws: IDS_DRAWS, report: (name) => name }
  if (specifier === 'node:crypto' || specifier === 'crypto') {
    return { draws: NODE_CRYPTO_DRAWS, report: (name) => `crypto.${name}` }
  }
  if (specifier === 'uuid') return { draws: UUID_PACKAGE_DRAWS, report: (name) => `uuid.${name}` }
  return undefined
}

/**
 * The draws `file` imports by name from a module that draws, and the local names it
 * binds such a module to as a namespace.
 *
 * @param file a parsed module.
 */
function drawImports(file: ts.SourceFile): {
  draws: Set<string>
  namespaces: Map<string, DrawOwner>
} {
  const draws = new Set<string>()
  const namespaces = new Map<string, DrawOwner>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    const owner = drawOwner(statement.moduleSpecifier.text)
    if (owner === undefined) continue
    const clause = statement.importClause
    if (clause?.name !== undefined) namespaces.set(clause.name.text, owner)
    const named = clause?.namedBindings
    if (named === undefined) continue
    if (ts.isNamespaceImport(named)) {
      namespaces.set(named.name.text, owner)
      continue
    }
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text
      if (owner.draws.has(imported)) draws.add(owner.report(imported))
    }
  }
  return { draws, namespaces }
}

/** Every draw `source` makes past the IdSource: imported, called or referenced. */
function directDraws(source: string): Set<string> {
  if (!DRAW_HINT.test(source)) return new Set()
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest)
  const { draws: found, namespaces } = drawImports(file)
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node)
      const owner = globalOwner(node.expression)
      if (name !== undefined && owner !== undefined && GLOBAL_DRAWS[owner]?.has(name)) {
        found.add(`${owner}.${name}`)
      }
      const namespace = ts.isIdentifier(node.expression)
        ? namespaces.get(node.expression.text)
        : undefined
      if (name !== undefined && namespace?.draws.has(name)) found.add(namespace.report(name))
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined
    ) {
      const global = globalOwner(node.initializer)
      const owner: DrawOwner | undefined =
        global !== undefined
          ? { draws: GLOBAL_DRAWS[global] ?? new Set(), report: (name) => `${global}.${name}` }
          : ts.isIdentifier(node.initializer)
            ? namespaces.get(node.initializer.text)
            : undefined
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name
        if (owner !== undefined && ts.isIdentifier(key) && owner.draws.has(key.text)) {
          found.add(owner.report(key.text))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

let scanned: Set<string> | undefined

function seamedDraws(): Set<string> {
  scanned ??= new Set(
    SEAMED_PACKAGES.flatMap((pkg) =>
      readdirSync(join(SRC_DIR, pkg), { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .flatMap((name) => {
          const module = [pkg, ...name.split(sep)].join('/')
          const draws = directDraws(readFileSync(join(SRC_DIR, pkg, name), 'utf8'))
          return [...draws].map((draw) => `${module} ${draw}`)
        }),
    ),
  )
  return scanned
}

describe('the IdSource seam', () => {
  it.each([
    ['crypto.randomUUID()', 'crypto.randomUUID'],
    ["crypto.randomUUID().replaceAll('-', '')", 'crypto.randomUUID'],
    ['crypto.getRandomValues(bytes)', 'crypto.getRandomValues'],
    ['globalThis.crypto.getRandomValues(bytes)', 'crypto.getRandomValues'],
    ["crypto['randomUUID']()", 'crypto.randomUUID'],
    ['Math.random()', 'Math.random'],
    ['Math.floor(Math.random() * 10)', 'Math.random'],
    ['globalThis.Math.random()', 'Math.random'],
    ['const draw = Math.random', 'Math.random'],
    ['const { random } = Math', 'Math.random'],
    ['const { randomUUID: mint } = globalThis.crypto', 'crypto.randomUUID'],
    ["import * as ids from '../../utils/ids.ts'\nconst { uuid7: mint } = ids\nmint()", 'uuid7'],
    ["import * as nc from 'node:crypto'\nconst { randomBytes } = nc", 'crypto.randomBytes'],
    ["import * as uuid from 'uuid'\nconst { v4 } = uuid\nv4()", 'uuid.v4'],
    ["import { randomUUID } from 'node:crypto'\nrandomUUID()", 'crypto.randomUUID'],
    ["import { randomBytes as bytes } from 'crypto'\nbytes(16)", 'crypto.randomBytes'],
    ["import * as nc from 'node:crypto'\nnc.randomInt(6)", 'crypto.randomInt'],
    ["import nc from 'node:crypto'\nnc.randomBytes(6)", 'crypto.randomBytes'],
    ["import { v4 } from 'uuid'\nv4()", 'uuid.v4'],
    ["import { v7 as mint } from 'uuid'\nmint()", 'uuid.v7'],
    ["import * as uuid from 'uuid'\nuuid.v1()", 'uuid.v1'],
    ["import { uuid7 } from '../../utils/ids'\nuuid7()", 'uuid7'],
    ["import { uuid7 } from '../../utils/ids.ts'\nuuid7()", 'uuid7'],
    ["import { newSessionId as mint } from '../utils/ids.js'\nmint()", 'newSessionId'],
    ["import * as ids from '../../utils/ids.ts'\nids.newWorkspaceId()", 'newWorkspaceId'],
  ])('flags %j as %j', (source, expected) => {
    expect(directDraws(source)).toEqual(new Set([expected]))
  })

  it.each([
    'this.ids.uuid7()',
    'ctx.ids.randomU32()',
    "import { type IdSource, SystemIdSource } from '../../utils/ids.ts'",
    "import { randomBelow, shuffle } from '../../utils/ids.ts'\nshuffle(ids, items)",
    "import * as ids from '../../utils/ids.ts'\nids.randomBelow(source, 10)",
    "await crypto.subtle.digest('SHA-256', bytes)",
    'Math.floor(value)',
    "import * as ids from '../../utils/ids.ts'\nconst { randomBelow } = ids",
    'const { floor } = Math',
    "import { createHash } from 'node:crypto'\ncreateHash('sha256')",
    "import { v5, validate } from 'uuid'\nv5(name, namespace)",
    "import { uuid7 } from './other.ts'\nuuid7()",
    'uuid7()',
    'random()',
  ])('allows %j', (source) => {
    expect(directDraws(source)).toEqual(new Set())
  })

  it('no seamed module draws past the IdSource', () => {
    const offenders = [...seamedDraws()].filter((draw) => !(draw in KEPT_ON_PROCESS_RANDOMNESS))
    expect(offenders).toEqual([])
  })

  it('every kept process draw is still made', () => {
    const draws = seamedDraws()
    const stale = Object.keys(KEPT_ON_PROCESS_RANDOMNESS).filter((draw) => !draws.has(draw))
    expect(stale).toEqual([])
  })
})
