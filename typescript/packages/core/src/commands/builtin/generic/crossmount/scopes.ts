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

import type { OwnedScope } from './types.ts'
import type { NamespaceView } from '../../../../ops/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FileType, PathSpec, type FileStat } from '../../../../types.ts'
import { isFsError } from '../../../../errors/fs.ts'
import { respellOne } from '../../../../utils/path.ts'
import { rstripSlash, stripSlash } from '../../../../utils/slash.ts'
import { isStdin } from '../../utils/stream.ts'

/** Lazily partition an operand into maximal scopes with one owner.
 * Only directories containing mount boundaries are expanded. Listings
 * come through the dispatcher so hidden and shadowed entries stay hidden. */
export async function* ownedScopes(
  path: PathSpec,
  dispatch: DispatchFn,
  ns: NamespaceView | undefined,
  admit: (path: PathSpec, stat: FileStat) => boolean,
  walked = false,
): AsyncIterable<OwnedScope> {
  if (path.walkError !== null || isStdin(path)) {
    yield { path, walked }
    return
  }
  let entries: string[]
  try {
    const [info] = await dispatch('stat', path, [], { nofollow: true })
    const stat = info as FileStat
    if (walked && !admit(path, stat)) return
    const boundaries = ns?.mounts?.descendants(path.virtual) ?? []
    if (stat.type !== FileType.DIRECTORY || boundaries.length === 0) {
      yield { path, walked, stat }
      return
    }
    entries = (await dispatch('readdir', path))[0] as string[]
  } catch (error) {
    if (!isFsError(error)) throw error
    yield { path, walked, error: error as Error }
    return
  }
  for (const entry of entries) {
    const virtual =
      path.virtual.replace(/\/$/, '') + '/' + (entry.replace(/\/$/, '').split('/').at(-1) ?? '')
    const child = new PathSpec({
      virtual,
      directory: virtual,
      vfsPath: virtual.replace(/^\/+|\/+$/g, ''),
      rawPath: respellOne(virtual, path.virtual, path.rawPath),
    })
    yield* ownedScopes(child, dispatch, ns, admit, true)
  }
}

/**
 * The operand, then each visible mount root below it, as start points.
 *
 * Each start is one mount's own part of the operand's tree: the operand's
 * mount answers for everything but the mounts inside it, and every mount
 * below answers from its root, spelled as the operand was typed. A hidden
 * mount is never a start, though it still shadows the parent backend's keys.
 */
export function mountStarts(path: PathSpec, ns: NamespaceView | undefined): PathSpec[] {
  if (path.walkError !== null || ns?.mounts === undefined) return [path]
  return [
    path,
    ...ns.mounts.visibleDescendants(path.virtual).map(
      (root) =>
        new PathSpec({
          virtual: root,
          directory: root,
          vfsPath: root.replace(/^\/+|\/+$/g, ''),
          rawPath: respellOne(root, path.virtual, path.rawPath),
        }),
    ),
  ]
}

/** Which start points a walk from their operand reaches.
 * A walk that cannot read a directory never sees what lies inside it,
 * mounts included. A start below a part whose run failed therefore counts
 * only when every directory from that part down to it lists through the
 * dispatcher; every other start counts as it is. */
export async function reached(
  paths: readonly PathSpec[],
  starts: readonly (readonly [number, PathSpec])[],
  failed: readonly boolean[],
  dispatch: DispatchFn,
): Promise<boolean[]> {
  const key = (index: number, virtual: string): string =>
    `${String(index)}\0${rstripSlash(virtual) || '/'}`
  const broken = new Set(
    starts.filter((_, i) => failed[i] === true).map(([index, start]) => key(index, start.virtual)),
  )
  const listed = new Map<string, boolean>()
  const lists = async (virtual: string): Promise<boolean> => {
    let known = listed.get(virtual)
    if (known === undefined) {
      try {
        await dispatch('readdir', PathSpec.fromStrPath(virtual))
        known = true
      } catch (err) {
        console.warn(`cannot list ${virtual}: ${String(err)}`)
        known = false
      }
      listed.set(virtual, known)
    }
    return known
  }
  const found: boolean[] = []
  for (const [index, start] of starts) {
    const path = paths[index]
    const base = rstripSlash(path?.virtual ?? '')
    const parts = stripSlash(start.virtual.slice(base.length)).split('/').slice(0, -1)
    const trail = [
      base || '/',
      ...parts.map((_, end) => `${base}/${parts.slice(0, end + 1).join('/')}`),
    ]
    const hit = trail.findIndex((d) => broken.has(key(index, d)))
    let reach = true
    if (start !== path && hit >= 0) {
      for (const virtual of trail.slice(hit)) {
        reach = await lists(virtual)
        if (!reach) break
      }
    }
    found.push(reach)
  }
  return found
}
