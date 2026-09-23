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

import { dotglobActive, pathAllowed } from '../context/session_context.ts'
import type { ChildMounts } from '../ops/types.ts'
import { type FileStat, FileType, PathSpec } from '../types.ts'
import { isFsError } from './errors.ts'
import { fnmatch } from './fnmatch.ts'
import { rekey } from './key_prefix.ts'
import { rstripSlash } from './slash.ts'
import { compareCodePoints } from './sort.ts'

export const GLOB_CHARS = ['*', '?', '[']

function isoDay(year: number, month: number, date: number): string {
  const mm = String(month).padStart(2, '0')
  const dd = String(date).padStart(2, '0')
  return `${String(year)}-${mm}-${dd}`
}

function isValidDate(year: number, month: number, date: number): boolean {
  if (month < 1 || month > 12 || date < 1) return false
  const d = new Date(Date.UTC(year, month - 1, date))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === date
}

function parseFixedInt(s: string | undefined, expectedLength: number): number | null {
  if (s?.length !== expectedLength || !/^\d+$/.test(s)) return null
  return Number.parseInt(s, 10)
}

/**
 * Whether a glob names a date range a windowed lister can move to.
 *
 * The kit's `patternKinds` table holds one of these per kind: a glob it
 * answers true for reaches the lister and bypasses the index, and any other
 * glob is filtered out of the ordinary cached listing.
 */
export function hasGlobSpan(pattern: string): boolean {
  return globSpan(pattern) !== null
}

/**
 * Whether a glob starts with literal text a query can narrow on.
 *
 * The `patternKinds` twin of `hasGlobSpan` for a backend whose window is a
 * row cap rather than a date range: the literal prefix becomes a prefix match
 * in the query, so the cap covers the region the line named instead of the
 * head of the table.
 */
export function hasGlobPrefix(pattern: string): boolean {
  return globPrefix(pattern) !== ''
}

/**
 * The literal text a glob starts with, before its first metacharacter.
 *
 * A quoted glob character travels under a private mark and stands for that
 * character literally, so the marks are restored here: `'*'ab*` asks for
 * names starting with a real star.
 */
export function globPrefix(pattern: string | null | undefined): string {
  if (!pattern) return ''
  let metaIndex = -1
  for (const ch of GLOB_CHARS) {
    const idx = pattern.indexOf(ch)
    if (idx !== -1 && (metaIndex === -1 || idx < metaIndex)) metaIndex = idx
  }
  if (metaIndex === -1) return ''
  return unmarkGlobs(pattern.slice(0, metaIndex))
}

/**
 * The literal prefix a glob puts on the stem of a leaf name.
 *
 * A leaf is a stem plus one of the renderer's suffixes, so a literal that has
 * run into a suffix says nothing about the stem and the part that ran in is
 * dropped: `12*.md` narrows to `12`, and `doc-1.m*` narrows to `doc-1` rather
 * than asking for stems that start `doc-1.m`. Only a tail that spells the head
 * of a suffix is dropped, which is what keeps a stem that contains a dot:
 * `acct.2026*` narrows to `acct.2026`, where cutting at the first dot would
 * narrow to `acct` and let the rows nobody asked for eat the window.
 */
export function globStemPrefix(pattern: string | null | undefined, suffixes: string[]): string {
  const literal = globPrefix(pattern)
  let reached = 0
  for (const suffix of suffixes) {
    for (let size = 1; size <= suffix.length; size += 1) {
      if (literal.endsWith(suffix.slice(0, size))) reached = Math.max(reached, size)
    }
  }
  return literal.slice(0, literal.length - reached)
}

/**
 * The half-open range of dates a date-prefixed glob asks for.
 *
 * The literal prefix before the first metacharacter is read as a year, a
 * month or a day, so `2026-*` spans a year and `2026-01-05*` one day. This is
 * what lets a windowed listing honour a glob instead of filtering its own
 * window: the backend moves the window to the span the line named. Dates are
 * floating `YYYY-MM-DD`, since a caller bucketing in a named time zone has to
 * build its own instants from them; UTC instants would shift the window by
 * the offset.
 */
export function globSpan(pattern: string | null | undefined): [string, string] | null {
  const literal = globPrefix(pattern)
  if (literal === '') return null
  const parts = literal.replace(/[_-]+$/, '').split('-')
  if (parts.length === 1) {
    const year = parseFixedInt(parts[0], 4)
    if (year === null) return null
    return [isoDay(year, 1, 1), isoDay(year + 1, 1, 1)]
  }
  if (parts.length === 2) {
    const year = parseFixedInt(parts[0], 4)
    const month = parseFixedInt(parts[1], 2)
    if (year === null || month === null) return null
    if (!isValidDate(year, month, 1)) return null
    if (month === 12) return [isoDay(year, month, 1), isoDay(year + 1, 1, 1)]
    return [isoDay(year, month, 1), isoDay(year, month + 1, 1)]
  }
  if (parts.length === 3) {
    const year = parseFixedInt(parts[0], 4)
    const month = parseFixedInt(parts[1], 2)
    const date = parseFixedInt(parts[2], 2)
    if (year === null || month === null || date === null) return null
    if (!isValidDate(year, month, date)) return null
    const next = new Date(Date.UTC(year, month - 1, date) + 86400000)
    return [
      isoDay(year, month, date),
      isoDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
    ]
  }
  return null
}

// A quoted glob character keeps travelling as a character, under a
// private mark, because bash tracks quoting per character and not per
// word: `'*'?.txt` still globs, on the `?` alone, and matches only a
// name starting with a literal star. A mark is one character wide, so
// every length relation between a spec's virtual, directory,
// vfsPath and rawPath keeps holding, and no mark is a glob
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
    vfsPath: unmarkGlobs(spec.vfsPath),
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
    vfsPath: spec.vfsPath,
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
// The namespace's stat of what an owed name points at, resolved through
// the workspace: null when the link dangles or loops.
export type TargetStat = (virtual: string) => Promise<FileStat | null>

// Whether a match is a directory, the way a trailing slash asks. A name
// the namespace owes the directory (a nested mount root or a link) is no
// backend's to stat: the namespace answers for it through `targetStat`,
// which follows a link and stats what it reaches, so a link to a
// directory is kept and a link to a file or to nothing is dropped, bash's
// own rule for `*/`. Without that door the owed name is kept, and without
// a stat door every match is kept, since nothing can tell them apart.
// Otherwise one stat per match, served from the index the readdir just
// filled.
async function isDirectory<A, I>(
  stat: ((accessor: A, path: PathSpec, index?: I) => Promise<FileStat>) | undefined,
  accessor: A,
  match: PathSpec,
  index: I | undefined,
  children: ChildMounts | undefined,
  targetStat: TargetStat | undefined,
): Promise<boolean> {
  if (stat === undefined) return true
  const trimmed = rstripSlash(match.virtual)
  const cut = trimmed.lastIndexOf('/')
  const parent = trimmed.slice(0, cut + 1)
  const name = trimmed.slice(cut + 1)
  if (children?.(parent).includes(name) === true) {
    if (targetStat === undefined) return true
    const target = await targetStat(trimmed)
    return target?.type === FileType.DIRECTORY
  }
  let row: FileStat
  try {
    row = await stat(accessor, match, index)
  } catch (err) {
    if (isFsError(err)) return false
    throw err
  }
  return row.type === FileType.DIRECTORY
}

export async function resolveGlobWith<A, I>(
  readdir: (accessor: A, path: PathSpec, index?: I) => Promise<string[]>,
  accessor: A,
  paths: readonly PathSpec[],
  index: I | undefined,
  cap?: number,
  children?: ChildMounts,
  stat?: (accessor: A, path: PathSpec, index?: I) => Promise<FileStat>,
  targetStat?: TargetStat,
): Promise<PathSpec[]> {
  const result: PathSpec[] = []
  for (const p of paths) {
    if (p.resolved) {
      result.push(p)
      continue
    }
    if (p.pattern !== null && p.pattern !== '') {
      // A trailing slash asks for directories only, and every match keeps
      // one (`*/` -> `sub/`), the same rule the shell tier applies in
      // workspace/expand/globs.ts. The slash is not part of the spelling
      // to rebuild, so it comes off the word here and goes back on each
      // match; the literal answer to a zero-match glob is still the word
      // as typed (#1065).
      const dirsOnly = p.rawPath.endsWith('/') && p.rawPath !== p.virtual
      const word = dirsOnly
        ? new PathSpec({
            virtual: p.virtual,
            directory: p.directory,
            vfsPath: p.vfsPath,
            pattern: p.pattern,
            resolved: p.resolved,
            rawPath: rstripSlash(p.rawPath),
          })
        : p
      // The hidden filter sits here, in the one loop every backend's
      // resolveGlob runs through, because per-backend glob modules bind
      // raw readdirs that never pass the command-door guard. It runs
      // before the empty-match test so an all-hidden match set reads as
      // no matches and falls back to the literal word, exactly what bash
      // prints when nothing matched.
      let matched = (await expandPattern(readdir, accessor, word, index, children)).filter((m) =>
        pathAllowed(m.virtual),
      )
      if (dirsOnly) {
        const kept: PathSpec[] = []
        for (const m of matched) {
          if (await isDirectory(stat, accessor, m, index, children, targetStat)) {
            kept.push(
              new PathSpec({
                virtual: m.virtual,
                directory: m.directory,
                vfsPath: m.vfsPath,
                pattern: m.pattern,
                resolved: m.resolved,
                rawPath: `${m.rawPath}/`,
              }),
            )
          }
        }
        matched = kept
      }
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
              vfsPath: p.vfsPath,
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
 * Whether one directory entry answers a pathname-expansion segment.
 * `fnmatch` plus bash's leading-dot rule: a name starting with `.` is
 * matched only by a pattern that also starts with `.` (so `*`, `?h` and
 * `[.]h` pass over `.h`), unless the session has `shopt -s dotglob`.
 * Pathname expansion's rule alone; `find -name` and `case` match through
 * `fnmatch` directly.
 */
export function globNameMatches(name: string, pattern: string): boolean {
  if (name.startsWith('.') && !pattern.startsWith('.') && !dotglobActive()) return false
  return fnmatch(name, pattern)
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
  const prefix = path.virtual.slice(0, rstripSlash(path.virtual).length - path.vfsPath.length)
  const segments = path.vfsPath === '' ? [] : path.vfsPath.split('/')
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
      // Directory-shaped, carrying the segment as the pattern: a backend
      // whose listing for this level is a bounded window moves the window to
      // what the glob asks for instead of filtering its own (gcal, gdocs and
      // the dated-message channels). Every other readdir reads the directory
      // off the same spec and ignores the field. A literal segment carries
      // none, so it keeps its warm listing.
      const spec = new PathSpec({
        virtual: parent,
        directory: parent,
        vfsPath: rekey(path.virtual, path.vfsPath, parent),
        pattern: hasGlob(seg) ? seg : null,
      })
      let entries: string[]
      try {
        entries = await readdir(accessor, spec, index)
      } catch (err) {
        if (!isMissingDir(err)) throw err
        entries = []
      }
      // A cold listing marks a folder with a trailing slash (box, gdrive,
      // dropbox); the marker is not part of the name.
      for (const e of entries) {
        const entry = rstripSlash(e)
        if (globNameMatches(entry.split('/').pop() ?? '', matcher)) nextLevel.push(entry)
      }
      if (children !== undefined) {
        // A nested mount root or a link is a real child of this parent
        // whether or not the backend could list it.
        const baseDir = rstripSlash(parent)
        for (const name of children(`${baseDir}/`)) {
          if (globNameMatches(name, matcher)) nextLevel.push(`${baseDir}/${name}`)
        }
      }
    }
    // bash sorts a pathname expansion, and the two sources are enumerated
    // separately, so the union is ordered here.
    level = [...new Set(nextLevel)].sort(compareCodePoints)
    if (level.length === 0) return []
  }
  const matches = level.map((e) => PathSpec.fromStrPath(e, rekey(path.virtual, path.vfsPath, e)))
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
        vfsPath: m.vfsPath,
        pattern: m.pattern,
        resolved: m.resolved,
        rawPath: spellMatch(raw, m.virtual, walked),
      }),
  )
}
