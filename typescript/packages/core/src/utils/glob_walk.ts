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

import { PathSpec } from '../types.ts'
import { fnmatch } from './fnmatch.ts'
import { rekey } from './key_prefix.ts'
import { rstripSlash } from './slash.ts'

export const GLOB_CHARS = ['*', '?', '[']

export function hasGlob(segment: string): boolean {
  return GLOB_CHARS.some((ch) => segment.includes(ch))
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
export async function resolveGlobWith<A, I>(
  readdir: (accessor: A, path: PathSpec, index?: I) => Promise<string[]>,
  accessor: A,
  paths: readonly PathSpec[],
  index: I | undefined,
  cap?: number,
): Promise<PathSpec[]> {
  const result: PathSpec[] = []
  for (const p of paths) {
    if (p.resolved) {
      result.push(p)
      continue
    }
    if (p.pattern !== null && p.pattern !== '') {
      const matched = await expandPattern(readdir, accessor, p, index)
      if (matched.length === 0 && isWordShaped(p)) {
        result.push(
          new PathSpec({
            virtual: p.virtual,
            directory: p.directory,
            resourcePath: p.resourcePath,
            pattern: null,
            resolved: true,
            rawPath: p.rawPath,
          }),
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
  const base = rstripSlash(prefix + segments.slice(0, first).join('/')) || '/'
  let level = [base]
  for (const seg of segments.slice(first)) {
    const nextLevel: string[] = []
    for (const parent of level) {
      const spec = PathSpec.fromStrPath(parent, rekey(path.virtual, path.resourcePath, parent))
      let entries: string[]
      try {
        entries = await readdir(accessor, spec, index)
      } catch (err) {
        if (isMissingDir(err)) continue
        throw err
      }
      for (const e of entries) {
        const name = rstripSlash(e).split('/').pop() ?? ''
        if (fnmatch(name, seg)) nextLevel.push(e)
      }
    }
    level = nextLevel
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
  return matches.map(
    (m) =>
      new PathSpec({
        virtual: m.virtual,
        directory: m.directory,
        resourcePath: m.resourcePath,
        pattern: m.pattern,
        resolved: m.resolved,
        rawPath: spellMatch(path.rawPath, m.virtual, walked),
      }),
  )
}
