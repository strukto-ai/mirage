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

import type { PathSpec } from '../../../../types.ts'
import { readOptional } from './io.ts'

import type { Files } from '../../../../workspace/files.ts'
import type { RepoLocation } from './types.ts'

export const GITIGNORE = '.gitignore'
export const INFO_EXCLUDE = 'info/exclude'

const DEC = new TextDecoder('utf-8', { fatal: false })

/** One parsed `.gitignore` line. */
export interface Rule {
  /** Matches the named path itself. */
  readonly self: RegExp
  /** Matches anything below the named path, whatever type it is. */
  readonly under: RegExp
  /** True for a `!` line, which un-ignores what the lines above caught. */
  readonly negated: boolean
  /** True for a trailing `/`, which can only match a directory itself. */
  readonly dirOnly: boolean
  /** The line's number, from one. */
  readonly line: number
  /** The pattern as the file spells it. */
  readonly text: string
}

/** One ignore file's rules and where they came from. */
export interface IgnoreFile {
  /** The directory the rules govern, repository-relative, empty at the root. */
  readonly prefix: string
  /** The file's name as `check-ignore` reports it. */
  readonly source: string
  readonly rules: readonly Rule[]
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
export function parseRules(text: string): Rule[] {
  const rules: Rule[] = []
  for (const [index, raw] of text.split('\n').entries()) {
    // Trailing whitespace is not part of a pattern unless it was escaped, and a
    // blank or commented line is not a pattern at all.
    let line = raw.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '')
    if (line === '' || line.startsWith('#')) continue
    const spelled = line
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
      line: index + 1,
      text: spelled,
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
 * Spell a repository-relative path relative to a filter's directory.
 *
 * A `.gitignore` names paths from its own directory down, so the same path is
 * a different string to each filter on the stack.
 *
 * @param prefix the filter's directory, repository-relative, empty at the root
 * @param path repository-relative path being tested
 */
function relative(prefix: string, path: string): string {
  return prefix === '' ? path : path.slice(prefix.length + 1)
}

/**
 * The rule that decides a path: the deepest file's last matching line.
 *
 * @param files the files governing the path's directory, innermost last
 * @param path repository-relative path
 * @param isDir whether the path names a directory
 */
export function lastMatch(
  files: readonly IgnoreFile[],
  path: string,
  isDir: boolean,
): [IgnoreFile, Rule] | null {
  for (const found of [...files].reverse()) {
    const own = relative(found.prefix, path)
    for (const rule of [...found.rules].reverse()) {
      if (rule.self.test(own) && (!rule.dirOnly || isDir)) return [found, rule]
    }
  }
  return null
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

  private readonly commandLine: Rule[] | null

  constructor(filters: readonly [string, Rule[]][] = [], commandLine: Rule[] | null = null) {
    this.filters = filters
    this.commandLine = commandLine
  }

  /**
   * A new stack with one more `.gitignore` on top.
   *
   * @param prefix the directory the file was found in, repository-relative
   * @param patterns the file's contents
   */
  push(prefix: string, patterns: Uint8Array): IgnoreStack {
    return new IgnoreStack(
      [...this.filters, [prefix, parseRules(DEC.decode(patterns))]],
      this.commandLine,
    )
  }

  /**
   * A new stack whose command-line rules outrank every file's.
   *
   * @param patterns the rules, one per line
   */
  commanded(patterns: Uint8Array): IgnoreStack {
    return new IgnoreStack(this.filters, parseRules(DEC.decode(patterns)))
  }

  /**
   * Whether git would leave a path out of an untracked listing.
   *
   * @param path repository-relative path
   * @param isDir whether the path names a directory, which decides whether a
   *   `build/` pattern can match it
   */
  isIgnored(path: string, isDir = false): boolean {
    if (this.commandLine !== null) {
      const typed = verdict(this.commandLine, path, isDir)
      if (typed !== null) return typed
    }
    for (let i = this.filters.length - 1; i >= 0; i--) {
      const held = this.filters[i]
      if (held === undefined) continue
      const [prefix, rules] = held
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue
      const answer = verdict(rules, relative(prefix, path), isDir)
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
 *
 * @param vfs the session's files
 * @param commondir the shared git directory, whose `info` a linked worktree
 *   reads too
 * @param worktree the working tree root
 */
export async function loadIgnores(
  vfs: Files,
  commondir: PathSpec,
  worktree: PathSpec,
): Promise<IgnoreStack> {
  let stack = new IgnoreStack()
  const private_ = await readOptional(vfs, commondir.join(INFO_EXCLUDE))
  if (private_ !== null) stack = stack.push('', private_)
  const root = await readOptional(vfs, worktree.join(GITIGNORE))
  if (root !== null) stack = stack.push('', root)
  return stack
}

/** The repository's two rule files, as `check-ignore` reports them. */
export async function loadIgnoreFiles(vfs: Files, location: RepoLocation): Promise<IgnoreFile[]> {
  const files: IgnoreFile[] = []
  const exclude = location.commondir.join(INFO_EXCLUDE)
  const privateRules = await readOptional(vfs, exclude)
  if (privateRules !== null) {
    const top = `${location.worktree.virtual.replace(/\/$/, '')}/`
    const source = exclude.virtual.startsWith(top)
      ? exclude.virtual.slice(top.length)
      : exclude.virtual
    files.push({ prefix: '', source, rules: parseRules(DEC.decode(privateRules)) })
  }
  const root = await readOptional(vfs, location.worktree.join(GITIGNORE))
  if (root !== null)
    files.push({ prefix: '', source: GITIGNORE, rules: parseRules(DEC.decode(root)) })
  return files
}
