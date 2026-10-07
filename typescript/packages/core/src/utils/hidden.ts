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

import type {
  HiddenPaths,
  HiddenVars,
  MountMode,
  ShowEntry,
  ShownPaths,
  Visibility,
} from '../types.ts'
import { PathSpec, weakerMode } from '../types.ts'
import { fnmatch } from './fnmatch.ts'
import { stripSlash } from './slash.ts'

/**
 * The characters that make a document entry a pattern rather than an
 * exact name; the permissions document has one grammar for every path
 * list, and this is the whole classification rule.
 */
const GLOB_CHARS = new Set(['*', '?', '['])

/** Whether a document entry is a pattern (any of `*`, `?`, `[`). */
export function isGlob(entry: string): boolean {
  for (const ch of entry) if (GLOB_CHARS.has(ch)) return true
  return false
}

/**
 * How specific a path entry is: the number of literal components before
 * its first wildcard.
 *
 * The one measure the permissions document's path axis orders by.
 * `/repo/sealed/*` is 2, `/repo/*` and the plain subtree `/repo` are 1,
 * and a slashless name pattern like `*.key` is 0, since it anchors
 * nothing. Every pattern the document allows has an answer, so two
 * entries about one path are always comparable and nothing is ever
 * guessed.
 *
 * It lives here beside `isGlob` rather than in the policy layer because
 * both gates need it: admission scores the rule that covers an operand,
 * and the entry gate scores the rule that covers an entry reached
 * mid-walk.
 */
export function anchorDepth(entry: string): number {
  let depth = 0
  for (const part of stripSlash(entry).split('/')) {
    if (part === '' || isGlob(part)) break
    depth += 1
  }
  return depth
}

/**
 * Compile document path entries into the matcher's shape: glob =
 * pattern, plain = exact subtree, in the order written. The same split
 * serves `paths.hide` and a `CommandRule`'s `paths`, so both planes
 * match through `pathHidden`. Null when there is nothing to match,
 * which is what "unrestricted" reads as.
 */
export function classifyPaths(entries: readonly string[]): HiddenPaths | null {
  const paths = entries.filter((e) => !isGlob(e))
  const patterns = entries.filter((e) => isGlob(e))
  if (paths.length === 0 && patterns.length === 0) return null
  return { paths, patterns }
}

/**
 * Compile document variable entries into the matcher's shape: glob =
 * pattern over names, plain = exact name. Null when empty.
 */
export function classifyVars(entries: readonly string[]): HiddenVars | null {
  const names = entries.filter((e) => !isGlob(e))
  const patterns = entries.filter((e) => isGlob(e))
  if (names.length === 0 && patterns.length === 0) return null
  return { names, patterns }
}

function normAbs(path: string): string {
  const stripped = stripSlash(path)
  return stripped === '' ? '/' : '/' + stripped
}

/**
 * The fixed directory above an anchored pattern's first glob segment,
 * normalized (`/x/locked/*` -> `/x/locked`).
 */
function patternHead(pattern: string): string {
  const fixed: string[] = []
  for (const seg of normAbs(pattern).split('/')) {
    if (isGlob(seg)) break
    fixed.push(seg)
  }
  return normAbs(fixed.join('/'))
}

/**
 * Whether a spec has anything at or under this virtual path.
 *
 * Asked for an op that acts on a whole subtree (a rename of a directory,
 * a recursive remove): `/x/locked/*` protects the children of
 * `/x/locked`, and moving or removing `/x/locked` or `/x` takes them
 * along, so the op on the directory or an ancestor counts as touching
 * the scope. Exact entries and the fixed head of an anchored pattern
 * are tested; a component pattern (no `/`) names no place, so only a
 * walk could tell and it is not counted here. With `ancestors` false
 * only the directory holding the scope counts, which is the question for
 * a destination: moving into `/x/locked` lands in the scope, moving into
 * `/x` does not.
 */
export function pathCovers(
  hidden: HiddenPaths | null | undefined,
  virtual: string,
  ancestors = true,
): boolean {
  if (hidden == null) return false
  const paths = hidden.paths ?? []
  const patterns = hidden.patterns ?? []
  if (paths.length === 0 && patterns.length === 0) return false
  const norm = normAbs(virtual)
  const heads = paths.map(normAbs)
  for (const p of patterns) if (p.includes('/')) heads.push(patternHead(p))
  if (heads.some((head) => head === norm)) return true
  return ancestors && heads.some((head) => norm === '/' || head.startsWith(norm + '/'))
}

/**
 * Whether an exact entry covers this normalized path: the entry itself
 * or anything in its subtree (prefix containment, no globbing).
 */
function matchesExact(entry: string, norm: string): boolean {
  const p = normAbs(entry)
  return norm === p || norm.startsWith(p + '/') || p === '/'
}

/**
 * Whether a slashless pattern hits any name component of the path,
 * which covers the subtree below a matching directory for free.
 */
function matchesComponent(pattern: string, parts: readonly string[]): boolean {
  return parts.some((seg) => fnmatch(seg, pattern))
}

/**
 * Whether an anchored pattern matches the path or an ancestor of it,
 * so a directory the pattern covers keeps its descendants covered.
 * Patterns match with the repo fnmatch dialect, `*` crossing slashes
 * as GNU `find -path` does.
 */
function matchesAnchored(pattern: string, parts: readonly string[]): boolean {
  const normPat = normAbs(pattern)
  let prefix = ''
  for (const seg of parts) {
    prefix = `${prefix}/${seg}`
    if (fnmatch(prefix, normPat)) return true
  }
  return false
}

/**
 * The deepest hide entry covering this virtual path, as its anchor
 * depth; null when none does.
 *
 * Depth is a property of the entry, never of where it matched: an
 * anchored pattern that covers a path through an ancestor still scores
 * its own `anchorDepth`, and a component pattern scores 0 wherever it
 * hits, since it anchors nothing.
 */
export function hideDepth(hidden: HiddenPaths | null | undefined, virtual: string): number | null {
  if (hidden == null) return null
  const paths = hidden.paths ?? []
  const patterns = hidden.patterns ?? []
  if (paths.length === 0 && patterns.length === 0) return null
  const norm = normAbs(virtual)
  const parts = norm.split('/').filter((seg) => seg !== '')
  let best: number | null = null
  for (const entry of paths) {
    if (matchesExact(entry, norm)) {
      const depth = anchorDepth(entry)
      if (best === null || depth > best) best = depth
    }
  }
  for (const pat of patterns) {
    if (pat.includes('/')) {
      if (matchesAnchored(pat, parts)) {
        const depth = anchorDepth(pat)
        if (best === null || depth > best) best = depth
      }
    } else if (best === null && matchesComponent(pat, parts)) {
      best = 0
    }
  }
  return best
}

/**
 * Whether the session's spec hides this virtual path, before any show
 * entry is consulted: what a rule's paths match through, and the hide
 * half of `pathVisible`.
 */
export function pathHidden(hidden: HiddenPaths | null | undefined, virtual: string): boolean {
  return hideDepth(hidden, virtual) !== null
}

/**
 * The place a show entry anchors to: the entry itself when exact, the
 * fixed directory above its first glob segment when a pattern.
 */
export function showHead(entry: string): string {
  return isGlob(entry) ? patternHead(entry) : normAbs(entry)
}

/**
 * The deepest show entry covering this virtual path, as its anchor
 * depth; null when none does.
 *
 * A show entry is always anchored (validation refuses a slashless
 * pattern), so it covers its own subtree the way an exact hide does; a
 * stray slashless pattern from a typed constructor covers nothing,
 * failing toward refusal.
 */
export function showDepth(shown: ShownPaths | null | undefined, virtual: string): number | null {
  if (shown == null || shown.entries.length === 0) return null
  const norm = normAbs(virtual)
  const parts = norm.split('/').filter((seg) => seg !== '')
  let best: number | null = null
  for (const entry of shown.entries) {
    if (isGlob(entry.path)) {
      if (!entry.path.includes('/') || !matchesAnchored(entry.path, parts)) continue
    } else if (!matchesExact(entry.path, norm)) continue
    const depth = anchorDepth(entry.path)
    if (best === null || depth > best) best = depth
  }
  return best
}

/**
 * Whether one session's path axis leaves this virtual path visible:
 * the whole composition law for the VFS axis.
 *
 * Three steps, each the anchor-depth rule: no hide covers the path and
 * it is visible; a show covers it more deeply than the deepest hide
 * and it is visible (hide wins the tie); and a hidden directory stays
 * visible when a visible show anchors strictly below it, so the road
 * to a carve-out exists (`hide /repo` + `show /repo/public` keeps
 * `/repo` listable, holding only the carve-out).
 */
export function pathVisible(vis: Visibility | null | undefined, path: PathSpec): boolean {
  const virtual = path.virtual
  if (vis == null) return true
  const deepestHide = hideDepth(vis.paths, virtual)
  if (deepestHide === null) return true
  const shown = vis.shown
  const deepestShow = showDepth(shown, virtual)
  if (deepestShow !== null && deepestShow > deepestHide) return true
  if (shown == null) return false
  const norm = normAbs(virtual)
  for (const entry of shown.entries) {
    const head = showHead(entry.path)
    if (head === norm) {
      // A globbed carve-out keeps its own anchor traversable: the
      // children `/repo/public/*` exposes score the anchor's depth, so
      // the anchor directory answers by the same compare (an exact
      // entry already answered through showDepth above).
      if (head !== entry.path && anchorDepth(entry.path) > deepestHide) return true
      continue
    }
    if (
      (norm === '/' || head.startsWith(norm + '/')) &&
      pathVisible(vis, PathSpec.fromStrPath(head))
    ) {
      return true
    }
  }
  return false
}

/**
 * The deepest mode-carrying show entry covering this path, as
 * [anchor depth, mode]; null when none does.
 *
 * A list-form entry (mode null) states visibility only and never
 * answers here. Two mode entries at one depth take the weaker, failing
 * toward refusal.
 */
export function shownMode(
  shown: ShownPaths | null | undefined,
  path: PathSpec,
): [number, MountMode] | null {
  if (shown == null || shown.entries.length === 0) return null
  const norm = normAbs(path.virtual)
  const parts = norm.split('/').filter((seg) => seg !== '')
  let best: [number, MountMode] | null = null
  for (const entry of shown.entries) {
    if (entry.mode == null) continue
    if (isGlob(entry.path)) {
      if (!entry.path.includes('/') || !matchesAnchored(entry.path, parts)) continue
    } else if (!matchesExact(entry.path, norm)) continue
    const depth = anchorDepth(entry.path)
    if (best === null || depth > best[0]) best = [depth, entry.mode]
    else if (depth === best[0]) best = [depth, weakerMode(best[1], entry.mode)]
  }
  return best
}

/**
 * Compile document show entries into the session's shape. Null when
 * there is nothing, which is what "the document states no show" reads
 * as, mirroring `classifyPaths`.
 */
export function classifyShows(entries: readonly ShowEntry[]): ShownPaths | null {
  return entries.length > 0 ? { entries } : null
}

/**
 * Whether the session could hide anything at or under this path: the
 * session form of `hidesIntersect`, for the view a native walk asks
 * before it trusts the raw tree.
 */
export function hiddenUnder(vis: Visibility | null | undefined, path: PathSpec): boolean {
  return hidesIntersect(vis?.paths, path.virtual)
}

/**
 * Whether a spec (a session's hides or a rule's paths) could cover
 * anything at or under this path.
 *
 * The per-operand gate for a native fast path: a backend's find op or
 * du total classifies the raw tree, so it must not be trusted when a
 * hide could cover an entry inside the subtree it answers for, and can
 * stay on when none can (a hidden `.env` under `/repo` must not force
 * `find` on `/s3` off its native op). A component pattern names no
 * place, so it intersects everything; otherwise an entry intersects
 * when its head lies at or under the path, or the path itself is
 * inside the entry's subtree.
 */
export function hidesIntersect(hidden: HiddenPaths | null | undefined, virtual: string): boolean {
  if (hidden == null) return false
  const paths = hidden.paths ?? []
  const patterns = hidden.patterns ?? []
  if (paths.length === 0 && patterns.length === 0) return false
  if (patterns.some((p) => !p.includes('/'))) return true
  if (pathHidden(hidden, virtual) || pathCovers(hidden, virtual)) return true
  // An anchored pattern's wildcard tail can match anywhere below its
  // fixed head, so an operand at or under that head may hold matches
  // inside its subtree (`/repo/*/secret` against a walk of
  // `/repo/public`) even though the operand itself is neither hidden
  // nor an ancestor of the head.
  const norm = normAbs(virtual)
  return patterns
    .filter((p) => p.includes('/'))
    .some((p) => {
      const head = patternHead(p)
      return head === '/' || norm.startsWith(head + '/')
    })
}

/**
 * Whether relocating `src` to `dst` could surface a hidden path.
 *
 * The reveal half of the subtree law: a session's mutation may destroy
 * what it cannot see (`rm -r`, a remnant `rmdir`), but may never reveal
 * it, and a rename or a native directory copy is the relocation that
 * would. Three arms, one per entry kind. A component pattern follows
 * the name wherever the content goes, so it never reveals. An exact
 * entry anchored strictly below `src` re-anchors to `dst` plus its
 * suffix, and reveals when the session would see that mapped path (a
 * show anchored below the mapped path counts, through `pathVisible`'s
 * own carve-out rule). An anchored pattern's coverage does not move
 * with the content, so any pattern whose match space could reach below
 * `src` refuses, failing toward refusal the way `readonlyBelow` blames
 * a pattern.
 */
export function moveReveals(
  vis: Visibility | null | undefined,
  src: PathSpec,
  dst: PathSpec,
): boolean {
  const hidden = vis?.paths
  if (hidden == null) return false
  const paths = hidden.paths ?? []
  const patterns = hidden.patterns ?? []
  if (paths.length === 0 && patterns.length === 0) return false
  const s = normAbs(src.virtual)
  const d = normAbs(dst.virtual)
  if (s === '/') return true
  for (const entry of paths) {
    const e = normAbs(entry)
    if (!e.startsWith(s + '/')) continue
    const mapped = (d === '/' ? '' : d) + e.slice(s.length)
    if (pathVisible(vis, PathSpec.fromStrPath(mapped))) return true
  }
  for (const pat of patterns) {
    if (!pat.includes('/')) continue
    const head = patternHead(pat)
    if (head === s || head.startsWith(s + '/') || head === '/' || s.startsWith(head + '/')) {
      return true
    }
  }
  return false
}

/** Whether the session hides this variable name. */
export function varHidden(vis: Visibility | null | undefined, name: string): boolean {
  const hidden = vis?.vars
  if (hidden == null) return false
  if ((hidden.names ?? []).includes(name)) return true
  for (const pat of hidden.patterns ?? []) {
    if (fnmatch(name, pat)) return true
  }
  return false
}
