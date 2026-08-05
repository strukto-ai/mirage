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

import { readOptional, under } from './io.ts'
import type { Dispatch } from './types.ts'

const GITIGNORE = '.gitignore'
const INFO_EXCLUDE = 'info/exclude'

const DEC = new TextDecoder('utf-8', { fatal: false })

/** One parsed `.gitignore` line. */
interface Rule {
  /** Matches the named path itself. */
  readonly self: RegExp
  /** Matches anything below the named path, whatever type it is. */
  readonly under: RegExp
  /** True for a `!` line, which un-ignores what the lines above caught. */
  readonly negated: boolean
  /** True for a trailing `/`, which can only match a directory itself. */
  readonly dirOnly: boolean
}

/**
 * Translate one gitignore pattern to a regular expression.
 *
 * The rules that matter, all of them gitignore's rather than fnmatch's:
 * `*` and `?` stop at a slash, `**` crosses them, a pattern holding a slash
 * anywhere but at its end is anchored to the file's own directory, and one that
 * does not is matched against any path component from the right.
 */
function translate(pattern: string, anchored: boolean): string {
  let out = anchored ? '^' : '^(?:.*/)?'
  let i = 0
  while (i < pattern.length) {
    const char = pattern.charAt(i)
    if (char === '*') {
      // `/**/` collapses to "any number of directories", which is the one
      // spelling that may also match nothing at all.
      if (pattern.charAt(i + 1) === '*') {
        const before = i === 0 || pattern.charAt(i - 1) === '/'
        const after = i + 2 >= pattern.length || pattern.charAt(i + 2) === '/'
        if (before && after) {
          if (pattern.charAt(i + 2) === '/') {
            out += '(?:.*/)?'
            i += 3
            continue
          }
          out += '.*'
          i += 2
          continue
        }
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (char === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close === -1) {
        out += '\\['
        i += 1
        continue
      }
      let body = pattern.slice(i + 1, close)
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      out += `[${body}]`
      i = close + 1
      continue
    }
    if (char === '\\' && i + 1 < pattern.length) {
      out += pattern.charAt(i + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      i += 2
      continue
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return out
}

/** Parse one `.gitignore` file's contents into rules, in file order. */
function parseRules(text: string): Rule[] {
  const rules: Rule[] = []
  for (const raw of text.split('\n')) {
    // Trailing whitespace is not part of a pattern unless it was escaped, and a
    // blank or commented line is not a pattern at all.
    let line = raw.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '')
    if (line === '' || line.startsWith('#')) continue
    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)
    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)
    // A leading slash anchors without being part of the pattern; a slash
    // anywhere else anchors too, but stays.
    const leading = line.startsWith('/')
    if (leading) line = line.slice(1)
    const anchored = leading || line.includes('/')
    const body = translate(line, anchored)
    // Two patterns rather than one: a `build/` rule matches the directory
    // itself only when it IS a directory, but covers everything under it
    // whatever type that is, which is what makes it hide the whole subtree.
    rules.push({
      self: new RegExp(`${body}$`),
      under: new RegExp(`${body}/`),
      negated,
      dirOnly,
    })
  }
  return rules
}

/**
 * One `.gitignore` file's verdict on a path: true, false, or null when no
 * pattern in it had anything to say. The last matching pattern wins, which is
 * how a `!` line un-ignores something the lines above it caught.
 */
function verdict(rules: readonly Rule[], path: string, isDir: boolean): boolean | null {
  let answer: boolean | null = null
  for (const rule of rules) {
    const own = rule.self.test(path) && (!rule.dirOnly || isDir)
    if (!own && !rule.under.test(path)) continue
    answer = !rule.negated
  }
  return answer
}

/**
 * The `.gitignore` files governing one directory, innermost last.
 *
 * Immutable, and pushed rather than mutated, so a walk hands each subdirectory
 * its own stack and cannot forget to pop one on the way back up.
 *
 * Precedence runs the opposite way to the list: a deeper file wins over a
 * shallower one, so the search runs from the end.
 */
export class IgnoreStack {
  private readonly filters: readonly [string, Rule[]][]

  constructor(filters: readonly [string, Rule[]][] = []) {
    this.filters = filters
  }

  /**
   * A new stack with one more `.gitignore` on top.
   *
   * @param prefix the directory the file was found in, repository-relative
   * @param patterns the file's contents
   */
  push(prefix: string, patterns: Uint8Array): IgnoreStack {
    return new IgnoreStack([...this.filters, [prefix, parseRules(DEC.decode(patterns))]])
  }

  /**
   * Whether git would leave a path out of an untracked listing.
   *
   * @param path repository-relative path
   * @param isDir whether the path names a directory, which decides whether a
   *   `build/` pattern can match it
   */
  isIgnored(path: string, isDir = false): boolean {
    for (let i = this.filters.length - 1; i >= 0; i--) {
      const held = this.filters[i]
      if (held === undefined) continue
      const [prefix, rules] = held
      // A `.gitignore` names paths from its own directory down, so the same
      // path is a different string to each filter on the stack.
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue
      const relative = prefix === '' ? path : path.slice(prefix.length + 1)
      const answer = verdict(rules, relative, isDir)
      if (answer !== null) return answer
    }
    return false
  }
}

/**
 * The root of the ignore stack: the repository's own two files.
 *
 * `.git/info/exclude` sits below the root `.gitignore` because it is the
 * repository's private list and a tracked `.gitignore` should be able to
 * override it.
 *
 * `core.excludesFile`, the per-user global list, is deliberately not read. It
 * names a path on whichever machine git ran on, and a mount has no way to reach
 * that machine's home directory; honoring it would mean reading the operator's
 * own file and applying it to somebody else's repository.
 */
export async function loadIgnores(
  dispatch: Dispatch,
  gitdir: string,
  worktree: string,
): Promise<IgnoreStack> {
  let stack = new IgnoreStack()
  const private_ = await readOptional(dispatch, under(gitdir, INFO_EXCLUDE))
  if (private_ !== null) stack = stack.push('', private_)
  const root = await readOptional(dispatch, under(worktree, GITIGNORE))
  if (root !== null) stack = stack.push('', root)
  return stack
}
