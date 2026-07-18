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

import {
  applyStateDict,
  toStateDict,
  type Workspace as CoreWorkspace,
  type WorkspaceStateDict,
} from '@struktoai/mirage-core'
import { readVersion, resolveRef } from './api.ts'
import { grantWidenings, sessionsDiff, type GrantWidening } from './stateDiff.ts'
import { toState } from './stateTree.ts'
import type { VersionStore } from './store.ts'

type AnyDict = Record<string, unknown>

const PLANES = ['files', 'sessions', 'namespace', 'history'] as const
type Plane = (typeof PLANES)[number]

export interface RestoreReport {
  version: string
  planes: Plane[]
  paths: string[] | null
  grant_widenings: GrantWidening[]
}

export interface RestoreOptions {
  paths?: string[]
  planes?: Plane[]
}

function normPath(p: string): string {
  let start = 0
  let end = p.length
  while (start < end && p[start] === '/') start++
  while (end > start && p[end - 1] === '/') end--
  return `/${p.slice(start, end)}`
}

function selectedFile(path: string, wanted: string[]): boolean {
  const p = normPath(path)
  return wanted.some((w) => {
    const want = normPath(w)
    return p === want || p.startsWith(`${want}/`)
  })
}

function mergeMountFiles(
  liveMount: AnyDict,
  targetMount: AnyDict,
  prefix: string,
  wanted: string[],
): void {
  const liveState = liveMount.resource_state as AnyDict
  const targetFiles =
    ((targetMount.resource_state as AnyDict).files as Record<string, Uint8Array> | undefined) ?? {}
  const files = { ...((liveState.files as Record<string, Uint8Array> | undefined) ?? {}) }
  const drop = new Set<string>()
  const base = prefix.replace(/\/+$/, '')
  for (const rel of new Set([...Object.keys(files), ...Object.keys(targetFiles)])) {
    if (!selectedFile(`${base}${rel}`, wanted)) continue
    const target = targetFiles[rel]
    if (target !== undefined) files[rel] = target
    else drop.add(rel)
  }
  liveState.files = Object.fromEntries(Object.entries(files).filter(([rel]) => !drop.has(rel)))
}

/**
 * Surgical restore: whole world, chosen planes, or chosen paths.
 *
 * Scope rules: no options = the whole world (checkout semantics);
 * `planes` picks a subset and leaves the live state of the others
 * untouched; `paths` restores only the matching files (a path selects
 * itself or its subtree) and implies the files plane alone. Restoring
 * sessions re-applies their mount grants, so the report carries
 * `grant_widenings`: every grant the restore widened relative to the
 * live state, surfaced, never silent. Mirrors the Python restore.
 */
export async function restore(
  store: VersionStore,
  ws: CoreWorkspace,
  ref: string,
  options: RestoreOptions = {},
): Promise<RestoreReport> {
  const { paths, planes } = options
  if (paths !== undefined && planes !== undefined) {
    throw new Error('restore takes paths or planes, not both')
  }
  for (const plane of planes ?? []) {
    if (!PLANES.includes(plane)) {
      throw new Error(`unknown plane '${plane as string}'; expected one of ${PLANES.join(', ')}`)
    }
  }
  const version = await resolveRef(store, ref)
  const { entries, meta } = await readVersion(store, version)
  const target = toState(entries, meta) as unknown as AnyDict
  const live = (await toStateDict(ws)) as unknown as AnyDict
  const fallback: readonly Plane[] = paths !== undefined ? ['files'] : PLANES
  const selected = new Set<Plane>(planes ?? fallback)

  let widenings: GrantWidening[] = []
  if (selected.has('sessions')) {
    const delta = sessionsDiff(
      (live.sessions as AnyDict[] | undefined) ?? [],
      (target.sessions as AnyDict[] | undefined) ?? [],
    )
    widenings = grantWidenings(delta)
  }

  const merged: AnyDict = { ...target }
  if (!selected.has('sessions')) {
    merged.sessions = (live.sessions as AnyDict[] | undefined) ?? []
    merged.default_session_id = live.default_session_id
  }
  if (!selected.has('namespace')) merged.nodes = (live.nodes as AnyDict | undefined) ?? {}
  if (!selected.has('history')) merged.history = (live.history as AnyDict[] | undefined) ?? []
  if (!selected.has('files')) {
    merged.mounts = (live.mounts as AnyDict[] | undefined) ?? []
  } else if (paths !== undefined) {
    const targetByPrefix = new Map(
      ((target.mounts as AnyDict[] | undefined) ?? []).map((m) => [m.prefix as string, m]),
    )
    merged.mounts = (live.mounts as AnyDict[] | undefined) ?? []
    for (const mount of merged.mounts as AnyDict[]) {
      const prefix = mount.prefix as string
      const targetMount = targetByPrefix.get(prefix)
      if (targetMount !== undefined) mergeMountFiles(mount, targetMount, prefix, paths)
    }
  }

  const cache = ws.cache as { clear?: () => Promise<void> }
  if (typeof cache.clear === 'function') await cache.clear()
  await applyStateDict(ws, merged as unknown as WorkspaceStateDict)
  return {
    version,
    planes: [...selected].sort(),
    paths: paths ?? null,
    grant_widenings: widenings,
  }
}
