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

import type { PredNode } from './findEval.ts'

const VALUE_PREDICATES = new Set([
  '-name',
  '-iname',
  '-path',
  '-type',
  '-size',
  '-mtime',
  '-maxdepth',
  '-mindepth',
])

const BARE_PREDICATES = new Set(['-empty', '-print', '-print0', '-delete', '-ls', '-depth'])

const OPERATORS = new Set(['-not', '!', '-o', '-or', '-a', '-and', '(', ')'])

function isExpressionToken(tok: string): boolean {
  return VALUE_PREDICATES.has(tok) || BARE_PREDICATES.has(tok) || OPERATORS.has(tok)
}

const VALID_TYPES = new Set(['b', 'c', 'd', 'p', 'f', 'l', 's'])

const MAX_DEPTH = 100

export class FindParseError extends Error {}

export interface FindExpr {
  tree: PredNode
  maxDepth: number | null
  minDepth: number | null
  minSize: number | null
  maxSize: number | null
  mtimeMin: number | null
  mtimeMax: number | null
  usesEmpty: boolean
}

function parseSize(spec: string): [number | null, number | null] {
  const suffixes: Record<string, number> = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }
  const raw = spec.startsWith('+') || spec.startsWith('-') ? spec.slice(1) : spec
  const last = raw[raw.length - 1] ?? ''
  const mult = suffixes[last] ?? 1
  const num = Number.parseInt(raw.replace(/[ckMG]$/, ''), 10) * mult
  if (spec.startsWith('+')) return [num, null]
  if (spec.startsWith('-')) return [null, num]
  return [num, num]
}

function parseMtime(spec: string): [number | null, number | null] {
  const day = 86400
  const now = Date.now() / 1000
  const n = Number.parseInt(spec.replace(/^[+-]/, ''), 10)
  if (spec.startsWith('+')) return [null, now - n * day]
  if (spec.startsWith('-')) return [now - n * day, null]
  return [now - (n + 1) * day, now - n * day]
}

function typeNode(value: string): PredNode {
  if (value === 'f' || value === 'file') return { op: 'type', kind: 'f' }
  if (value === 'd' || value === 'directory') return { op: 'type', kind: 'd' }
  if (VALID_TYPES.has(value)) return { op: 'type', kind: value }
  throw new FindParseError(`find: Unknown argument to -type: ${value}`)
}

function intArg(value: string, flag: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n)) throw new FindParseError(`find: invalid argument '${value}' to '${flag}'`)
  return n
}

function sizeArg(value: string): [number | null, number | null] {
  const [lo, hi] = parseSize(value)
  if ((lo !== null && Number.isNaN(lo)) || (hi !== null && Number.isNaN(hi)))
    throw new FindParseError(`find: invalid argument '${value}' to '-size'`)
  return [lo, hi]
}

function mtimeArg(value: string): [number | null, number | null] {
  const [lo, hi] = parseMtime(value)
  if ((lo !== null && Number.isNaN(lo)) || (hi !== null && Number.isNaN(hi)))
    throw new FindParseError(`find: invalid argument '${value}' to '-mtime'`)
  return [lo, hi]
}

export function findExprTail(rawArgv: string[]): string[] {
  for (let i = 0; i < rawArgv.length; i++) {
    const tok = rawArgv[i]
    if (tok === undefined) continue
    if (isExpressionToken(tok) || (tok.startsWith('-') && tok.length > 1)) {
      return rawArgv.slice(i)
    }
  }
  return []
}

export function parseFindExpression(tokens: string[]): FindExpr {
  const g = {
    maxDepth: null as number | null,
    minDepth: null as number | null,
    minSize: null as number | null,
    maxSize: null as number | null,
    mtimeMin: null as number | null,
    mtimeMax: null as number | null,
    usesEmpty: false,
  }
  let pos = 0
  let depth = 0
  const peek = (): string | undefined => (pos < tokens.length ? tokens[pos] : undefined)
  const advance = (): string | undefined => {
    const t = peek()
    if (t !== undefined) pos += 1
    return t
  }

  function primary(): PredNode {
    const tok = advance()
    if (tok === undefined) throw new FindParseError('find: expected predicate')
    if (VALUE_PREDICATES.has(tok)) {
      const value = advance()
      if (value === undefined) throw new FindParseError(`find: missing argument to '${tok}'`)
      if (tok === '-name') return { op: 'name', pattern: value, icase: false }
      if (tok === '-iname') return { op: 'name', pattern: value, icase: true }
      if (tok === '-path') return { op: 'path', pattern: value }
      if (tok === '-type') return typeNode(value)
      if (tok === '-maxdepth') {
        g.maxDepth = intArg(value, '-maxdepth')
        return { op: 'true' }
      }
      if (tok === '-mindepth') {
        g.minDepth = intArg(value, '-mindepth')
        return { op: 'true' }
      }
      if (tok === '-size') {
        ;[g.minSize, g.maxSize] = sizeArg(value)
        return { op: 'true' }
      }
      ;[g.mtimeMin, g.mtimeMax] = mtimeArg(value)
      return { op: 'true' }
    }
    if (tok === '-empty') {
      g.usesEmpty = true
      return { op: 'empty' }
    }
    if (BARE_PREDICATES.has(tok)) return { op: 'true' }
    throw new FindParseError(`find: unknown predicate '${tok}'`)
  }

  function factor(): PredNode {
    depth += 1
    if (depth > MAX_DEPTH) throw new FindParseError('find: expression too deeply nested')
    try {
      const tok = peek()
      if (tok === '-not' || tok === '!') {
        advance()
        return { op: 'not', kid: factor() }
      }
      if (tok === '(') {
        advance()
        const node = orExpr()
        if (peek() !== ')') throw new FindParseError('find: unbalanced parentheses')
        advance()
        return node
      }
      return primary()
    } finally {
      depth -= 1
    }
  }

  function andExpr(): PredNode {
    const factors = [factor()]
    for (;;) {
      const tok = peek()
      if (tok === '-a' || tok === '-and') {
        advance()
        factors.push(factor())
        continue
      }
      if (tok === undefined || tok === '-o' || tok === '-or' || tok === ')') break
      factors.push(factor())
    }
    const [firstFactor, ...restFactors] = factors
    if (firstFactor === undefined) return { op: 'true' }
    return restFactors.length === 0 ? firstFactor : { op: 'and', kids: factors }
  }

  function orExpr(): PredNode {
    const terms = [andExpr()]
    while (peek() === '-o' || peek() === '-or') {
      advance()
      terms.push(andExpr())
    }
    const [firstTerm, ...restTerms] = terms
    if (firstTerm === undefined) return { op: 'true' }
    return restTerms.length === 0 ? firstTerm : { op: 'or', kids: terms }
  }

  if (tokens.length === 0) return { tree: { op: 'true' }, ...g }
  const tree = orExpr()
  const trailing = peek()
  if (trailing !== undefined) throw new FindParseError(`find: unexpected token '${trailing}'`)
  return { tree, ...g }
}
