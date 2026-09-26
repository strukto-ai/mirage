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

// globset's own words for a glob it cannot compile (ripgrep 14.1.1).
export const UNCLOSED_CLASS = "unclosed character class; missing ']'"
export const UNCLOSED_ALTERNATES =
  "unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)"
export const UNOPENED_ALTERNATES =
  "unopened alternate group; missing '{' (maybe escape '}' with '[}]'?)"
export const NESTED_ALTERNATES = 'nested alternate groups are not allowed'
export const DANGLING_ESCAPE = "dangling '\\'"

/**
 * What one of ripgrep's path matchers says about a path: nothing, leave it
 * out, or keep it whatever the later filters would say (the ignore crate's
 * `Match`).
 */
export enum Verdict {
  NONE = 'none',
  IGNORE = 'ignore',
  WHITELIST = 'whitelist',
}

const SPECIAL = /[\\^$.|?*+()[\]{}\-/]/

function escapeChar(ch: string): string {
  return SPECIAL.test(ch) ? `\\${ch}` : ch
}

// ripgrep's refusal of a glob it cannot compile, exit 2.
export function globError(glob: string, reason: string): UsageError {
  return new UsageError(`rg: error parsing glob '${glob}': ${reason}`)
}

// One `[...]` class as regex source, and where the text resumes. `shown` is
// the glob as typed, for the refusal wording; `i` is just past the `[`.
function classSource(shown: string, text: string, i: number): [string, number] {
  const negated = i < text.length && (text[i] === '!' || text[i] === '^')
  if (negated) i += 1
  const members: string[] = []
  let first = true
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === ']' && !first) {
      return [(negated ? '[^' : '[') + members.join('') + ']', i + 1]
    }
    first = false
    if (i + 2 < text.length && text[i + 1] === '-' && text[i + 2] !== ']') {
      members.push(escapeChar(ch) + '-' + escapeChar(text[i + 2] ?? ''))
      i += 3
      continue
    }
    members.push(escapeChar(ch))
    i += 1
  }
  throw globError(shown, UNCLOSED_CLASS)
}

// A run of `*` as regex source, and where the glob resumes. `**` recurses
// only as a whole path component (at the start or after `/`, and at the end
// or before `/`); anywhere else it is two plain stars, which never cross `/`
// (globset with literal separators).
function starSource(glob: string, i: number, stars: number): [string, number] {
  const start = i - stars
  if (stars < 2) return ['[^/]*', i]
  const atStart = start === 0 || glob[start - 1] === '/'
  const atEnd = i === glob.length || glob[i] === '/'
  if (!(atStart && atEnd)) return ['[^/]*', i]
  if (i === glob.length) return ['.*', i]
  // `**/` (leading or between components) is zero or more whole
  // components; the `/` it ends with is part of it.
  return ['(?:.*/)?', i + 1]
}

// Regex source for `text`, one alternative of `glob` or all of it; `nested`
// says whether `text` already sits inside `{...}`.
function globBody(glob: string, text: string, nested: boolean): string {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '\\') {
      if (i + 1 >= text.length) throw globError(glob, DANGLING_ESCAPE)
      out.push(escapeChar(text[i + 1] ?? ''))
      i += 2
    } else if (ch === '*') {
      let j = i
      while (j < text.length && text[j] === '*') j += 1
      const [source, next] = starSource(text, j, j - i)
      out.push(source)
      i = next
    } else if (ch === '?') {
      out.push('[^/]')
      i += 1
    } else if (ch === '[') {
      const [source, next] = classSource(glob, text, i + 1)
      out.push(source)
      i = next
    } else if (ch === '{') {
      if (nested) throw globError(glob, NESTED_ALTERNATES)
      const [close, parts] = alternates(glob, text, i + 1)
      out.push('(?:' + parts.map((part) => globBody(glob, part, true)).join('|') + ')')
      i = close + 1
    } else if (ch === '}' && !nested) {
      throw globError(glob, UNOPENED_ALTERNATES)
    } else {
      out.push(escapeChar(ch))
      i += 1
    }
  }
  return out.join('')
}

// The alternatives of one `{...}` group and the index of its `}`; `i` is
// just past the `{`.
function alternates(glob: string, text: string, i: number): [number, string[]] {
  const parts: string[] = []
  let current: string[] = []
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '\\' && i + 1 < text.length) {
      current.push(text.slice(i, i + 2))
      i += 2
      continue
    }
    if (ch === '[') {
      const [, end] = classSource(glob, text, i + 1)
      current.push(text.slice(i, end))
      i = end
      continue
    }
    if (ch === '{') throw globError(glob, NESTED_ALTERNATES)
    if (ch === '}') {
      parts.push(current.join(''))
      return [i, parts]
    }
    if (ch === ',') {
      parts.push(current.join(''))
      current = []
    } else {
      current.push(ch)
    }
    i += 1
  }
  throw globError(glob, UNCLOSED_ALTERNATES)
}

/**
 * ripgrep's glob syntax as one anchored matcher: globset with literal
 * separators and backslash escapes, which is what ripgrep builds every `-g`
 * and `--type` glob with. `*` and `?` stay inside one path component, `**`
 * spans components, `[...]` and `{a,b}` are classes and alternatives.
 * `shown` is the glob as the line typed it, when that is not `glob` itself
 * (a `-g` line after ignore-rule rewriting), for the refusal wording.
 */
export function compileGlob(glob: string, caseInsensitive = false, shown?: string): RegExp {
  const source = globBody(shown ?? glob, glob, false)
  return new RegExp(`^(?:${source})$`, caseInsensitive ? 'i' : '')
}

/**
 * One `-g` glob read as ripgrep reads it: a gitignore line whose sense is
 * inverted, so a plain glob keeps a path and `!glob` drops it. `dirOnly`:
 * the glob ended in `/`, so it speaks only for directories.
 */
export interface OverrideGlob {
  matcher: RegExp
  keep: boolean
  dirOnly: boolean
}

/**
 * Parse one `-g` value the way the ignore crate parses a gitignore line, or
 * null for a line that says nothing (empty, or a `#` comment). A glob with
 * no `/` in it matches at any depth; one with a `/`, or a leading `/`, is
 * anchored to the path as walked. A trailing `/` limits it to directories,
 * and `dir/**` keeps everything below the directory but not the directory
 * itself.
 */
export function overrideGlob(line: string, caseInsensitive: boolean): OverrideGlob | null {
  if (line.startsWith('#')) return null
  if (!line.endsWith('\\ ')) line = line.trimEnd()
  if (line === '') return null
  const shown = line
  let keep = true
  let absolute = false
  if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1)
    absolute = line.startsWith('/')
  } else {
    if (line.startsWith('!')) {
      keep = false
      line = line.slice(1)
    }
    if (line.startsWith('/')) {
      line = line.slice(1)
      absolute = true
    }
  }
  let dirOnly = false
  if (line.endsWith('/')) {
    dirOnly = true
    line = line.slice(0, -1)
    if (line.endsWith('\\')) line = line.slice(0, -1)
  }
  let actual = line
  if (!absolute && !line.includes('/') && !(actual.startsWith('**/') || actual === '**')) {
    actual = '**/' + actual
  }
  if (actual.endsWith('/**')) actual += '/*'
  return { matcher: compileGlob(actual, caseInsensitive, shown), keep, dirOnly }
}

/**
 * ripgrep's `-g`/`--iglob` matcher (the ignore crate's `Override`). The last
 * glob that matches a path decides it, a `!` one dropping it and a plain one
 * keeping it whatever the type and hidden filters would say. Once any plain
 * glob exists, a file no glob matches is dropped, while a directory no glob
 * matches is still walked. `iglobs` come after every `-g`, whatever order
 * the line gave them.
 */
export class Overrides {
  private readonly globs: readonly OverrideGlob[]
  private readonly keeps: boolean

  constructor(globs: readonly string[], iglobs: readonly string[], caseInsensitive: boolean) {
    const parsed = [
      ...globs.map((g) => overrideGlob(g, caseInsensitive)),
      ...iglobs.map((g) => overrideGlob(g, true)),
    ]
    this.globs = parsed.filter((g): g is OverrideGlob => g !== null)
    this.keeps = this.globs.some((g) => g.keep)
  }

  // What the globs say about one walked path (`walkCandidate`'s form).
  verdict(path: string, isDir: boolean): Verdict {
    if (this.globs.length === 0) return Verdict.NONE
    for (let i = this.globs.length - 1; i >= 0; i--) {
      const glob = this.globs[i]
      if (glob === undefined || (glob.dirOnly && !isDir)) continue
      if (glob.matcher.test(path)) return glob.keep ? Verdict.WHITELIST : Verdict.IGNORE
    }
    if (this.keeps && !isDir) return Verdict.IGNORE
    return Verdict.NONE
  }
}

/**
 * The path ripgrep matches a walked entry's globs against: the walked path
 * as printed, with a leading `./` dropped and the working directory stripped
 * off an absolute one, which is what the ignore crate's `strip` does with
 * the override root (the cwd).
 */
export function walkCandidate(shown: string, cwd: string): string {
  const path = shown.startsWith('./') ? shown.slice(2) : shown
  if (!path.startsWith('/')) return path
  const root = cwd.replace(/\/+$/, '')
  if (root === '') return path.replace(/^\/+/, '')
  if (path.startsWith(root + '/')) return path.slice(root.length + 1)
  return path
}
