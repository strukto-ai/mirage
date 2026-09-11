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

import { PathSpec, type ContentType } from '../../types.ts'
import { stripSlash } from '../../utils/slash.ts'
import { RAW, type Codec } from './codec.ts'

export const ROOT = 'root'
export const INVALID = 'invalid'

/**
 * One dynamic segment of a scope: the key the decoded value is stored under,
 * and how the segment encodes it. `idKey` is set for `<label>__<id>`
 * composite segments: the decoded payload splits on its LAST `__` (so a
 * three-part `KEY__name__id` keeps `KEY__name` as the label), the label
 * stored under `name` and the id under `idKey`. A payload with no `__` or an
 * empty half does not match the scope.
 *
 * A `variadic` slot stands for a run of one or more consecutive segments
 * instead of exactly one. Segments before it anchor at the start of the
 * path, segments after it at the end, every segment in the run must decode,
 * and the stored value comes from the run's DEEPEST segment: notion's pages
 * nest arbitrarily, and `pages/a__1/b__2/page.json` stores `page=b,
 * page_id=2` because the innermost page is the one the path addresses. At
 * most one variadic slot per scope.
 */
export class Slot {
  readonly name: string
  readonly codec: Codec
  readonly idKey: string | null
  readonly variadic: boolean

  constructor(name: string, codec: Codec = RAW, idKey: string | null = null, variadic = false) {
    this.name = name
    this.codec = codec
    this.idKey = idKey
    this.variadic = variadic
  }
}

/**
 * One addressable position in a fixed API hierarchy.
 *
 * `kind` is the position's name; listers, probes and readers key on it.
 * `segments` is the path shape, literals and slots. `leaf` marks a file
 * rather than a directory, `filetype` its rendered content type. `probed` is whether
 * stat must prove existence (parent listing by default); false for positions
 * that exist by construction, like the top-level directories.
 */
export class Scope {
  readonly kind: string
  readonly segments: readonly (string | Slot)[]
  readonly leaf: boolean
  readonly filetype: ContentType | null
  readonly probed: boolean

  constructor(init: {
    kind: string
    segments: readonly (string | Slot)[]
    leaf?: boolean
    filetype?: ContentType
    probed?: boolean
  }) {
    this.kind = init.kind
    this.segments = init.segments
    this.leaf = init.leaf ?? false
    this.filetype = init.filetype ?? null
    this.probed = init.probed ?? true
  }
}

/**
 * Where in the hierarchy a path landed.
 *
 * `kind` is the matched scope's kind, or `root`/`invalid`. `slots` holds
 * the decoded dynamic segments by name. `resourcePath` is the raw path that
 * was classified. `scope` is the matched scope; null for root and invalid.
 */
/**
 * Where in the hierarchy a path landed.
 *
 * `pattern` is the glob the line typed for the directory's children, set only
 * for a kind named in `patternKinds` and null everywhere else. A lister whose
 * listing is a window moves that window to the span the glob asks for instead
 * of filtering its own; every other consumer ignores the field, the way a
 * command ignores the `CommandOpts` facts it does not read.
 */
export interface ScopeMatch {
  readonly kind: string
  readonly resourcePath: string
  readonly slots: Record<string, string>
  readonly scope: Scope | null
  readonly pattern: string | null
}

export type DetectFn = (path: PathSpec | string) => ScopeMatch

/** Decode one path segment through a slot, null when it does not fit. */
export function decodeSlot(slot: Slot, part: string): Record<string, string> | null {
  const decoded = slot.codec.decode(part)
  if (decoded === null) return null
  if (slot.idKey !== null) {
    const cut = decoded.lastIndexOf('__')
    const label = cut > 0 ? decoded.slice(0, cut) : ''
    const ident = cut >= 0 ? decoded.slice(cut + 2) : ''
    if (label === '' || ident === '') return null
    return { [slot.name]: label, [slot.idKey]: ident }
  }
  return { [slot.name]: decoded }
}

/** The scope's variadic slot and its position, null when it has none. */
export function variadicSlot(segments: readonly (string | Slot)[]): [number, Slot] | null {
  let found: [number, Slot] | null = null
  for (const [i, segment] of segments.entries()) {
    if (typeof segment !== 'string' && segment.variadic) {
      if (found !== null) throw new Error('a scope holds at most one variadic slot')
      found = [i, segment]
    }
  }
  return found
}

function matchRun(
  segments: readonly (string | Slot)[],
  parts: readonly string[],
): Record<string, string> | null {
  const slots: Record<string, string> = {}
  for (const [i, segment] of segments.entries()) {
    const part = parts[i] ?? ''
    if (typeof segment === 'string') {
      if (part !== segment) return null
      continue
    }
    const values = decodeSlot(segment, part)
    if (values === null) return null
    Object.assign(slots, values)
  }
  return slots
}

function matchSegments(
  segments: readonly (string | Slot)[],
  parts: readonly string[],
): Record<string, string> | null {
  const found = variadicSlot(segments)
  if (found === null) {
    if (segments.length !== parts.length) return null
    return matchRun(segments, parts)
  }
  if (parts.length < segments.length) return null
  const [at, slot] = found
  const tailLen = segments.length - at - 1
  const head = matchRun(segments.slice(0, at), parts.slice(0, at))
  if (head === null) return null
  const tail = matchRun(segments.slice(at + 1), parts.slice(parts.length - tailLen))
  if (tail === null) return null
  let values: Record<string, string> | null = null
  for (const part of parts.slice(at, parts.length - tailLen)) {
    values = decodeSlot(slot, part)
    if (values === null) return null
  }
  if (values === null) return null
  return { ...head, ...values, ...tail }
}

/** Match path segments against the table, first declared scope wins. */
export function matchScope(
  scopes: readonly Scope[],
  parts: readonly string[],
): [Scope, Record<string, string>] | null {
  for (const scope of scopes) {
    const slots = matchSegments(scope.segments, parts)
    if (slots !== null) return [scope, slots]
  }
  return null
}

/**
 * Build a path classifier from a scope table.
 *
 * The classifier is the single description of the backend's tree: readdir,
 * stat, read, and any search push-down all dispatch on its result, so the
 * file surface and the command surface cannot disagree about what a path
 * means. Hidden segments classify as invalid, which every consumer turns
 * into ENOENT. Scopes are matched in declaration order.
 *
 * Postgres's table, classified level by level:
 *
 *     path                             kind         slots
 *     /                                root         {}
 *     /public                          schema       {schema}
 *     /public/tables                   kind         {schema, kind}
 *     /public/tables/books             entity       {schema, kind, entity}
 *     /public/tables/books/rows.jsonl  entity_rows  {schema, kind, entity}
 *
 * `kind` names the level a path landed on; the slots identify the branch
 * taken at each dynamic level above it. Literal levels (`rows.jsonl`)
 * contribute no slot, and one dynamic level can contribute two (`idKey`).
 */
export function makeDetectScope(scopes: readonly Scope[]): DetectFn {
  for (const scope of scopes) variadicSlot(scope.segments)
  return function detectScope(path: PathSpec | string): ScopeMatch {
    const raw = path instanceof PathSpec ? path.mountPath : path
    const key = stripSlash(raw)
    if (key === '') return { kind: ROOT, resourcePath: raw, slots: {}, scope: null, pattern: null }
    const parts = key.split('/')
    if (parts.some((p) => p.startsWith('.'))) {
      return { kind: INVALID, resourcePath: raw, slots: {}, scope: null, pattern: null }
    }
    const matched = matchScope(scopes, parts)
    if (matched === null)
      return { kind: INVALID, resourcePath: raw, slots: {}, scope: null, pattern: null }
    const [scope, slots] = matched
    return { kind: scope.kind, resourcePath: raw, slots, scope, pattern: null }
  }
}
