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

import type { HiddenPaths, Visibility } from '../types.ts'
import {
  admissionMatcher,
  fromUnits,
  linkTraceWire,
  units,
  visibilityMatcher,
} from '../rs/policy.ts'
import { traceSymlinks } from './path.ts'

/** Whether a document entry is a pattern (any of `*`, `?`, `[`). */
export function isGlob(entry: string): boolean {
  return admissionMatcher(null).ask('is_glob', { entry: units(entry) }) === true
}
/**
 * Compile document path entries into the matcher's shape: glob =
 * pattern, plain = exact subtree, in the order written. The same split
 * serves `paths.hide` and a `CommandRule`'s `paths`, so both planes
 * match the same way. Null when there is nothing to match,
 * which is what "unrestricted" reads as.
 */
export function classifyPaths(entries: readonly string[]): HiddenPaths | null {
  const scope = admissionMatcher(null).ask('classify_paths', { entries: entries.map(units) }) as {
    paths: number[][]
    patterns: number[][]
  }
  if (scope.paths.length + scope.patterns.length === 0) return null
  return { paths: scope.paths.map(fromUnits), patterns: scope.patterns.map(fromUnits) }
}
/**
 * The place a show entry anchors to: the entry itself when exact, the
 * fixed directory above its first glob segment when a pattern.
 */
export function showHead(entry: string): string {
  return fromUnits(admissionMatcher(null).ask('show_head', { entry: units(entry) }) as number[])
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
export function pathVisible(vis: Visibility | null | undefined, virtual: string): boolean {
  return (
    vis?.paths == null ||
    visibilityMatcher(vis).ask('path_visible', { path: units(virtual) }) === true
  )
}
/**
 * Whether relocating `src` to `dst` could surface a hidden path.
 *
 * The reveal half of the subtree law: a session's mutation may destroy
 * what it cannot see (`rm -r`, a remnant `rmdir`), but may never reveal
 * it, and a rename or a native directory copy is the relocation that
 * would. A source the session reaches only through a show below it is
 * hidden itself, so whatever the show does not reopen reveals wherever the
 * session sees `dst`. Beyond that, three arms, one per entry kind. A
 * component pattern follows
 * the name wherever the content goes, so it never reveals. An exact
 * entry anchored strictly below `src` re-anchors to `dst` plus its
 * suffix, and reveals when the session would see that mapped path (a
 * show anchored below the mapped path counts, through `pathVisible`'s
 * own carve-out rule). An anchored pattern's coverage does not move
 * with the content, so any pattern whose match space could reach below
 * `src` refuses, failing toward refusal the way `readonlyBelow` blames
 * a pattern.
 */
export function moveReveals(vis: Visibility | null | undefined, src: string, dst: string): boolean {
  return (
    vis?.paths != null &&
    visibilityMatcher(vis).ask('move_reveals', { src: units(src), dst: units(dst) }) === true
  )
}
/**
 * Whether a visible name leads where the session cannot see: a link the walk
 * follows names a hidden path. The walk judges what a link brings in, not the
 * typed path, which the caller judges whole (a carve-out keeps its hidden
 * parents traversable): each link's own path, every name a stored target
 * spells before a later `..` takes it back (`/data/secret/../pub` still
 * prints `secret`), and the place the walk lands. Such a link is as hidden as
 * its target, since its listing row, `readlink` and `ls -l` would print the
 * hidden name; a link that leads nowhere (dangling, or a loop) leads nowhere
 * hidden. Mirrors Python's leads_hidden.
 */
export function leadsHidden(
  vis: Visibility | null | undefined,
  virtual: string,
  links: ReadonlyMap<string, string>,
): boolean {
  return (
    vis?.paths != null &&
    links.size > 0 &&
    visibilityMatcher(vis).ask('link_trace_hidden', {
      trace: linkTraceWire(traceSymlinks(virtual, links)),
    }) === true
  )
}
export function visibleLinks(
  vis: Visibility | null | undefined,
  paths: readonly string[],
  links: ReadonlyMap<string, string>,
): boolean[] {
  if (vis?.paths == null) return paths.map(() => true)
  const matcher = visibilityMatcher(vis)
  const shown = matcher.ask('visible_links', {
    candidates: paths.map((path) => ({ path: units(path), trace: [] })),
  }) as boolean[]
  const checked = matcher.ask('visible_links', {
    candidates: paths
      .filter((_, index) => shown[index])
      .map((path) => ({ path: units(path), trace: linkTraceWire(traceSymlinks(path, links)) })),
  }) as boolean[]
  let index = 0
  return shown.map((keep) => keep && checked[index++] === true)
}
/**
 * Whether the session could hide anything at or under this path, for
 * the view a native walk asks before it trusts the raw tree: a hide at
 * or under the path, or a pattern whose head could reach it.
 */
export function hiddenUnder(vis: Visibility | null | undefined, virtual: string): boolean {
  return (
    vis?.paths != null &&
    visibilityMatcher(vis).ask('hides_intersect', { path: units(virtual) }) === true
  )
}
/** Whether the session hides this variable name. */
export function varHidden(vis: Visibility | null | undefined, name: string): boolean {
  return (
    vis?.vars != null && visibilityMatcher(vis).ask('var_hidden', { name: units(name) }) === true
  )
}
