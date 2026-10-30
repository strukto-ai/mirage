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

import { UsageError } from '../errors.ts'
import { DEFAULT_TYPES } from '../../utils/generated/rg_types.ts'
import { Verdict, compileGlob } from './rg_glob.ts'

export { DEFAULT_TYPES } from '../../utils/generated/rg_types.ts'

// ripgrep's refusal of a --type-add it cannot read, whatever is wrong with it
// (a missing glob, a bad name, `all`, an unknown include), exit 2 (ripgrep
// 14.1.1).
export const INVALID_DEFINITION = 'rg: invalid definition (format is type:glob, e.g., html:*.html)'
// The name that selects every type at once; it cannot be defined.
export const ALL_TYPES = 'all'

const ALNUM = /^[\p{L}\p{N}]+$/u

// Add one glob to a type, creating the type if it is new. The name is
// alphanumeric and never `all`.
function addGlob(defs: Map<string, string[]>, name: string, glob: string): void {
  if (name === ALL_TYPES || !ALNUM.test(name)) throw new UsageError(INVALID_DEFINITION)
  const globs = defs.get(name)
  if (globs === undefined) defs.set(name, [glob])
  else globs.push(glob)
}

/**
 * Apply one --type-add, `name:glob` or `name:include:t1,t2`, refusing a
 * malformed definition in ripgrep's words.
 */
export function addDefinition(defs: Map<string, string[]>, definition: string): void {
  const parts = definition.split(':')
  if (parts.length === 2) {
    const [name = '', glob = ''] = parts
    if (name === '' || glob === '') throw new UsageError(INVALID_DEFINITION)
    addGlob(defs, name, glob)
    return
  }
  if (parts.length === 3) {
    const [name = '', keyword = '', included = ''] = parts
    if (name === '' || keyword !== 'include' || included === '') {
      throw new UsageError(INVALID_DEFINITION)
    }
    const names = included.split(',')
    if (names.some((t) => !defs.has(t))) throw new UsageError(INVALID_DEFINITION)
    for (const t of names) {
      for (const glob of [...(defs.get(t) ?? [])]) addGlob(defs, name, glob)
    }
    return
  }
  throw new UsageError(INVALID_DEFINITION)
}

/** The --type-clear and --type-add values in line order. */
export type TypeChange = readonly ['clear' | 'add', string]
/** The -t and -T names in line order, each with whether it negates (-T). */
export type TypeSelection = readonly [string, boolean]

/**
 * ripgrep's -t/-T matcher (the ignore crate's `Types`). Types match a file's
 * name, never a directory. The last selection whose globs match decides: -t
 * keeps the file whatever the hidden filter says, -T drops it. Once any -t
 * is given, a file no selected type matches is dropped. A malformed
 * definition, a selected type that does not exist, or a selected glob that
 * does not compile is refused.
 */
export class FileTypes {
  readonly definitions: Map<string, string[]>
  private readonly selected: boolean
  private readonly globs: readonly (readonly [RegExp, boolean])[]

  constructor(changes: readonly TypeChange[], selections: readonly TypeSelection[]) {
    const defs = new Map<string, string[]>(
      Object.entries(DEFAULT_TYPES).map(([name, globs]) => [name, [...globs]]),
    )
    for (const [kind, value] of changes) {
      if (kind === 'clear') defs.delete(value)
      else addDefinition(defs, value)
    }
    this.definitions = defs
    this.selected = selections.some(([, negated]) => !negated)
    const globs: (readonly [RegExp, boolean])[] = []
    for (const [name, negated] of selections) {
      let chosen: readonly string[]
      if (name === ALL_TYPES) chosen = [...defs.values()].flat()
      else {
        const found = defs.get(name)
        if (found === undefined) throw new UsageError(`rg: unrecognized file type: ${name}`)
        chosen = found
      }
      for (const g of chosen) globs.push([compileGlob(g), negated])
    }
    this.globs = globs
  }

  // What the selections say about one walked entry, by its file name.
  verdict(name: string, isDir: boolean): Verdict {
    if (isDir || this.globs.length === 0) return Verdict.NONE
    let last: boolean | null = null
    for (const [matcher, negated] of this.globs) {
      if (matcher.test(name)) last = negated
    }
    if (last === null) return this.selected ? Verdict.IGNORE : Verdict.NONE
    return last ? Verdict.IGNORE : Verdict.WHITELIST
  }
}

// Code-point order, which is Python's `sorted` on str.
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** --type-list: every type and its globs, both sorted, one per line. */
export function typeListing(defs: ReadonlyMap<string, readonly string[]>): string[] {
  return [...defs.keys()]
    .sort(byCodePoint)
    .map((name) => `${name}: ${[...(defs.get(name) ?? [])].sort(byCodePoint).join(', ')}`)
}
