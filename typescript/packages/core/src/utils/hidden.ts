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
import {
  hiddenMatcher,
  policyAnchorDepth,
  policyClassifyPaths,
  policyClassifyVars,
  policyIsGlob,
  policyShowHead,
  shownMatcher,
  varsMatcher,
  visibilityMatcher,
} from '../rs/policy.ts'
import { traceSymlinks } from './path.ts'

export function isGlob(entry: string): boolean {
  return policyIsGlob(entry)
}
export function anchorDepth(entry: string): number {
  return policyAnchorDepth(entry)
}
export function classifyPaths(entries: readonly string[]): HiddenPaths | null {
  return policyClassifyPaths(entries)
}
export function classifyVars(entries: readonly string[]): HiddenVars | null {
  return policyClassifyVars(entries)
}
export function hideDepth(hidden: HiddenPaths | null | undefined, virtual: string): number | null {
  return hidden == null ? null : hiddenMatcher(hidden).hideDepth(virtual)
}
export function pathHidden(hidden: HiddenPaths | null | undefined, virtual: string): boolean {
  return hideDepth(hidden, virtual) !== null
}
export function showHead(entry: string): string {
  return policyShowHead(entry)
}
export function showDepth(shown: ShownPaths | null | undefined, virtual: string): number | null {
  return shown == null ? null : shownMatcher(shown).showDepth(virtual)
}
export function pathVisible(vis: Visibility | null | undefined, virtual: string): boolean {
  return vis?.paths == null || visibilityMatcher(vis).pathVisible(virtual)
}
export function shownMode(
  shown: ShownPaths | null | undefined,
  virtual: string,
): readonly [number, MountMode] | null {
  return shown == null ? null : shownMatcher(shown).shownMode(virtual)
}
export function classifyShows(entries: readonly ShowEntry[]): ShownPaths | null {
  return entries.length === 0 ? null : { entries: [...entries] }
}
export function pathCovers(
  hidden: HiddenPaths | null | undefined,
  virtual: string,
  ancestors = true,
): boolean {
  return hidden != null && hiddenMatcher(hidden).pathCovers(virtual, ancestors)
}
export function moveReveals(vis: Visibility | null | undefined, src: string, dst: string): boolean {
  return vis?.paths != null && visibilityMatcher(vis).moveReveals(src, dst)
}
export function leadsHidden(
  vis: Visibility | null | undefined,
  virtual: string,
  links: ReadonlyMap<string, string>,
): boolean {
  return (
    vis?.paths != null &&
    links.size > 0 &&
    visibilityMatcher(vis).linkTraceHidden(traceSymlinks(virtual, links))
  )
}
export function visibleLinks(
  vis: Visibility | null | undefined,
  paths: readonly string[],
  links: ReadonlyMap<string, string>,
): boolean[] {
  if (vis?.paths == null) return paths.map(() => true)
  const matcher = visibilityMatcher(vis)
  const shown = matcher.visibleLinks(paths.map((path) => [path, []]))
  const selected = paths.filter((_, index) => shown[index])
  const checked = matcher.visibleLinks(selected.map((path) => [path, traceSymlinks(path, links)]))
  let index = 0
  return shown.map((keep) => keep && checked[index++] === true)
}
export function hiddenUnder(vis: Visibility | null | undefined, virtual: string): boolean {
  return vis?.paths != null && visibilityMatcher(vis).hidesIntersect(virtual)
}
export function hidesIntersect(hidden: HiddenPaths | null | undefined, virtual: string): boolean {
  return hidden != null && hiddenMatcher(hidden).hidesIntersect(virtual)
}
export function varHidden(vis: Visibility | null | undefined, name: string): boolean {
  return vis?.vars != null && varsMatcher(vis.vars).varHidden(name)
}
