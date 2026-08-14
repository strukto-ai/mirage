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

import { pathAllowed } from '../context/session_context.ts'
import type { ChildMounts } from '../ops/types.ts'
import { PathSpec } from '../types.ts'
import { fnmatch } from './fnmatch.ts'
import { rekey } from './key_prefix.ts'
import { rstripSlash } from './slash.ts'
import { compareCodePoints } from './sort.ts'

export const GLOB_CHARS = ['*', '?', '[']

// A quoted glob character keeps travelling as a character, under a
// private mark, because bash tracks quoting per character and not per
// word: `'*'?.txt` still globs, on the `?` alone, and matches only a
// name starting with a literal star. A mark is one character wide, so
// every length relation between a spec's virtual, directory,
// resourcePath and rawPath keeps holding, and no mark is a glob
// character, so `hasGlob` already answers "does this word still glob".
// The marks are Unicode noncharacters, permanently unassigned and never
// valid interchange text -- the same impossible input `brace.ts` assumes
// away when it delimits its inert atoms with NUL.
const GLOB_MARKS: Readonly<Record<string, string>> = {
  '*': '\uFDD0',
  '?': '\uFDD1',
  '[': '\uFDD2',
}
const GLOB_CHAR_OF: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(GLOB_MARKS).map(([ch, mark]) => [mark, ch]),
)
// One native pass, not a per-character rebuild: every expanded word is
// marked and unmarked, so a JS-level loop made the cost quadratic in a
// loop that grows one word (`while true; do export X=$X.; done`).
const GLOB_CHAR_RE = /[*?[]/g
const GLOB_MARK_RE = /[\uFDD0-\uFDD2]/g

export const DEFAULT_MAX_GLOB_MATCHES = 10000

export function hasGlob(segment: string): boolean {
  return GLOB_CHARS.some((ch) => segment.includes(ch))
}

// Quote every glob character, the way enclosing quotes would.
export function markGlobs(text: string): string {
  return text.replace(GLOB_CHAR_RE, (ch) => GLOB_MARKS[ch] ?? ch)
}

// The literal spelling: every quoted glob character as itself.
export function unmarkGlobs(text: string): string {
  return text.replace(GLOB_MARK_RE, (ch) => GLOB_CHAR_OF[ch] ?? ch)
}

// Whether text still carries a glob character quoting made literal.
function hasGlobMarks(text: string): boolean {
  return Object.keys(GLOB_CHAR_OF).some((mark) => text.includes(mark))
}

/**
 * Mark the glob characters a backslash quotes in raw word text.
 *
 * Read the way bash reads an unquoted word: `\*` is a quoted star and
 * `\\*` is a literal backslash followed by a live star. The backslash is
 * left in place for the quote-removal pass that follows, which drops it
 * and leaves the mark behind.
 */
export function markEscapedGlobs(text: string): string {
  if (!text.includes('\\')) return text
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i] ?? ''
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1] ?? ''
      out += ch + (GLOB_MARKS[next] ?? next)
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * A marked segment as the pattern fnmatch has to see.
 *
 * fnmatch has no escape character, so a quoted glob character is handed
 * over as its own one-character class, exactly what `escapeGlob` builds
 * for text that is literal throughout.
 */
export function globPattern(segment: string): string {
  return segment.replace(GLOB_MARK_RE, (ch) => `[${GLOB_CHAR_OF[ch] ?? ch}]`)
}

// Drop the marks from a spec, leaving the literal path it names.
function unmarkSpec(spec: PathSpec): PathSpec {
  return new PathSpec({
    virtual: unmarkGlobs(spec.virtual),
    directory: unmarkGlobs(spec.directory),
    resourcePath: unmarkGlobs(spec.resourcePath),
    rawPath: unmarkGlobs(spec.rawPath),
    pattern: spec.pattern === null ? null : unmarkGlobs(spec.pattern),
    resolved: spec.resolved,
  })
}

/**
 * The word after quote removal, once glob resolution is over.
 *
 * The marks come off here, and a word still carrying a pattern is frozen
 * as its literal: that pattern outlived its marks (an unmatched glob,
 * `set -f`, a backend that could not resolve it), and reading the
 * unmarked text as a pattern again would let a quoted metacharacter
 * match -- `rm '/data/*'?.txt` would be back to reaching every name the
 * live `?` alone would. A word that carried no marks is returned
 * untouched.
 */
export function literalWord(item: string | PathSpec): string | PathSpec {
  if (typeof item === 'string') return unmarkGlobs(item)
  if (!hasGlobMarks(item.virtual) && !hasGlobMarks(item.pattern ?? '')) return item
  const spec = unmarkSpec(item)
  if (spec.pattern === null) return spec
  return new PathSpec({
    virtual: spec.virtual,
    directory: spec.directory,
    resourcePath: spec.resourcePath,
    rawPath: spec.rawPath,
    pattern: null,
    resolved: true,
  })
}

/**
 * Encode text so the glob matcher reads every character literally.
 *
 * fnmatch has no escape character, so each special is wrapped in its own
 * one-character class: `*` becomes `[*]`. A `]` needs no treatment: outside
 * a class it is already literal, and no class can open because every `[`
 * gets wrapped.
 */
export function escapeGlob(text: string): string {
  let out = ''
  for (const c of text) {
    out += GLOB_CHARS.includes(c) ? `[${c}]` : c
  }
  return out
}

// Whether a pattern spec is a typed word (not a directory listing). A
// classify-shaped word puts the pattern inside `virtual` (`/data/s*/x.txt`
// with directory `/data/s*/`); a dir-shaped spec (`PathSpec.dir`) sets
// `virtual` to the directory itself.
export function isWordShaped(p: PathSpec): boolean {
  return rstripSlash(p.virtual) !== rstripSlash(p.directory)
}

// Spell a match the way bash expansion would. Bash rewrites only the glob
// segments of the typed word; everything before the first glob segment keeps
// its typed spelling, so `../s*/x.txt` expands to `../sub/x.txt`. The walked
// tail has the same segment count in the typed word and in the match's
// virtual path, so the spelling is the typed head plus the match's last
// `walked` segments.
export function spellMatch(raw: string, virtual: string, walked: number): string {
  const head = rstripSlash(raw).split('/').slice(0, -walked)
  const tail = rstripSlash(virtual).split('/').slice(-walked)
  return [...head, ...tail].join('/')
}

function isMissingDir(err: unknown): boolean {
  const code = (err as { code?: string }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// Shared resolve_glob loop: resolved specs pass through, pattern specs
// expand segment-by-segment (mid-path aware, spelled as typed), an
// unmatched glob word stays the literal (bash nullglob off: the command
// then errors on it like GNU), and matches cap at `cap` when given.
// Per-backend glob modules bind their own readdir.
//
// The spec shape is how a caller chooses between the two answers, and the
// choice matters because the literal is not distinguishable from a match by
// looking at it: a file may be named exactly like the word that globbed for
// it. A word-shaped spec asks for bash's own answer, literal included. A
// directory-shaped spec (`PathSpec.dir`) asks for matches alone, so an empty
// list means nothing matched -- what a caller merging these matches with
// another source needs, since only it can tell whether the union is empty.
export async function resolveGlobWith<A, I>(
  readdir: (accessor: A, path: PathSpec, index?: I) => Promise<string[]>,
  accessor: A,
  paths: readonly PathSpec[],
  index: I | undefined,
  cap?: number,
  children?: ChildMounts,
): Promise<PathSpec[]> {
  const result: PathSpec[] = []
  for (const p of paths) {
    if (p.resolved) {
      result.push(p)
      continue
    }
    if (p.pattern !== null && p.pattern !== '') {
      // The hidden filter sits here, in the one loop every backend's
      // resolveGlob runs through, because per-backend glob modules bind
      // raw readdirs that never pass the command-door guard. It runs
      // before the empty-match test so an all-hidden match set reads as
      // no matches and falls back to the literal word, exactly what bash
      // prints when nothing matched.
      const matched = (await expandPattern(readdir, accessor, p, index, children)).filter((m) =>
        pathAllowed(m.virtual),
      )
      // Dir-shaped specs keep the empty result, which is what a caller
      // that has to merge these matches with another source asks for.
      if (matched.length === 0 && isWordShaped(p)) {
        // The literal is the word after quote removal, so the marks come
        // off here.
        result.push(
          unmarkSpec(
            new PathSpec({
              virtual: p.virtual,
              directory: p.directory,
              resourcePath: p.resourcePath,
              pattern: null,
              resolved: true,
              rawPath: p.rawPath,
            }),
          ),
        )
        continue
      }
      result.push(...(cap !== undefined && matched.length > cap ? matched.slice(0, cap) : matched))
    } else {
      result.push(p)
    }
  }
  return result
}

/**
 * Expand a glob PathSpec segment-by-segment via readdir.
 *
 * Mirrors bash globbing: every path component containing a glob character is
 * matched against the entries of its (already expanded) parent directory, so
 * a mid-path pattern (a `Demo_*` directory segment followed by `page.md`)
 * never reaches the backend as a literal `*` path segment. An intermediate
 * match that cannot be listed (a file, or a vanished entry) is skipped,
 * matching bash's directories-only descent for non-final components.
 */
export async function expandPattern<A, I>(
  readdir: (accessor: A, path: PathSpec, index?: I) => Promise<string[]>,
  accessor: A,
  path: PathSpec,
  index?: I,
  children?: ChildMounts,
): Promise<PathSpec[]> {
  const prefix = path.virtual.slice(0, rstripSlash(path.virtual).length - path.resourcePath.length)
  const segments = path.resourcePath === '' ? [] : path.resourcePath.split('/')
  // Two spec shapes reach resolvers: a full pattern path (classify), where
  // the pattern is already the last segment, and a directory-shaped spec
  // (PathSpec.dir), where the pattern applies to the directory's entries.
  if (path.pattern !== null && path.pattern !== '' && segments.at(-1) !== path.pattern) {
    segments.push(path.pattern)
  }
  let first = segments.findIndex((seg) => hasGlob(seg))
  if (first < 0) first = segments.length - 1
  // The head above the first glob segment is a real directory, so a glob
  // character quoted inside it is part of the name to list.
  const base = unmarkGlobs(rstripSlash(prefix + segments.slice(0, first).join('/')) || '/')
  let level = [base]
  for (const seg of segments.slice(first)) {
    const nextLevel: string[] = []
    const matcher = globPattern(seg)
    for (const parent of level) {
      const spec = PathSpec.fromStrPath(parent, rekey(path.virtual, path.resourcePath, parent))
      let entries: string[]
      try {
        entries = await readdir(accessor, spec, index)
      } catch (err) {
        if (!isMissingDir(err)) throw err
        entries = []
      }
      for (const e of entries) {
        const name = rstripSlash(e).split('/').pop() ?? ''
        if (fnmatch(name, matcher)) nextLevel.push(e)
      }
      if (children !== undefined) {
        // A nested mount root or a link is a real child of this parent
        // whether or not the backend could list it.
        const baseDir = rstripSlash(parent)
        for (const name of children(`${baseDir}/`)) {
          if (fnmatch(name, matcher)) nextLevel.push(`${baseDir}/${name}`)
        }
      }
    }
    // bash sorts a pathname expansion, and the two sources are enumerated
    // separately, so the union is ordered here.
    level = [...new Set(nextLevel)].sort(compareCodePoints)
    if (level.length === 0) return []
  }
  const matches = level.map((e) =>
    PathSpec.fromStrPath(e, rekey(path.virtual, path.resourcePath, e)),
  )
  // A typed word (raw differs from virtual) spells its matches; the
  // dir-shaped specs internal expansions build (PathSpec.dir) have no typed
  // form and keep the resolved virtual.
  if (path.rawPath === path.virtual) return matches
  const walked = segments.length - first
  const raw = unmarkGlobs(path.rawPath)
  return matches.map(
    (m) =>
      new PathSpec({
        virtual: m.virtual,
        directory: m.directory,
        resourcePath: m.resourcePath,
        pattern: m.pattern,
        resolved: m.resolved,
        rawPath: spellMatch(raw, m.virtual, walked),
      }),
  )
}
