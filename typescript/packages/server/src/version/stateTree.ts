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

import { lstripSlash, stripSlash, type WorkspaceStateDict } from '@struktoai/mirage-core'

export type { WorkspaceStateDict }

export type AnyDict = Record<string, unknown>

// The four restorable categories of a whole-world version.
export const CATEGORIES = ['files', 'sessions', 'namespace', 'history'] as const
export type Category = (typeof CATEGORIES)[number]

// The control-plane subtree: everything about the workspace that is
// not file content lives under one reserved directory, so a commit is
// the WHOLE world (files + sessions + namespace + history) while file
// paths stay clean. Cache stays out: it is derived and rebuildable.
export const CONTROL_PREFIX = '.mirage/'
export const META_PATH = '.mirage/meta.json'
const SESSIONS_PATH = '.mirage/sessions.json'
const NAMESPACE_PATH = '.mirage/namespace.json'
// History mirrors the live ObserverStore layout: one append-only jsonl
// per session, merged on read by stable timestamp sort (the events()
// contract). A session that ran nothing since the last commit keeps an
// identical blob, so it dedups in the content-addressed store.
const HISTORY_PREFIX = '.mirage/history/'

export interface VersionMeta {
  version: number
  mounts: AnyDict[]
  cache: { limit: number; entries: AnyDict[] }
  fingerprints: unknown[]
  liveOnlyMounts: string[]
  defaultSessionId?: string | undefined
}

export interface TreeInputs {
  entries: Record<string, Uint8Array>
  meta: VersionMeta
}

function stripSlashes(p: string): string {
  return stripSlash(p)
}

function treePath(prefix: string, rel: string): string {
  const p = stripSlashes(prefix)
  const r = lstripSlash(rel)
  return p === '' ? r : `${p}/${r}`
}

function relPath(prefix: string, tp: string): string {
  const p = stripSlashes(prefix)
  const rest = p === '' ? tp : tp.slice(p.length + 1)
  return `/${rest}`
}

function belongs(treePrefix: string, tp: string): boolean {
  if (treePrefix === '') return true
  return tp === treePrefix || tp.startsWith(`${treePrefix}/`)
}

function isReserved(tp: string): boolean {
  return tp.startsWith(CONTROL_PREFIX)
}

export function metaToBlob(meta: VersionMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta))
}

export function blobToMeta(data: Uint8Array): VersionMeta {
  return JSON.parse(new TextDecoder().decode(data)) as VersionMeta
}

function jsonBlob(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function parseJsonBlob(data: Uint8Array): AnyDict {
  return JSON.parse(new TextDecoder().decode(data)) as AnyDict
}

function historyEntries(events: unknown[]): Record<string, Uint8Array> {
  const bySession = new Map<string, string[]>()
  for (const e of events) {
    const session = ((e as AnyDict).session as string | undefined) ?? 'default'
    const lines = bySession.get(session) ?? []
    lines.push(JSON.stringify(e))
    bySession.set(session, lines)
  }
  const entries: Record<string, Uint8Array> = {}
  for (const [session, lines] of bySession) {
    entries[`${HISTORY_PREFIX}${session}.jsonl`] = new TextEncoder().encode(`${lines.join('\n')}\n`)
  }
  return entries
}

function historyFromEntries(entries: Record<string, Uint8Array>): unknown[] {
  const events: unknown[] = []
  for (const treePath of Object.keys(entries).sort()) {
    if (!treePath.startsWith(HISTORY_PREFIX)) continue
    const data = entries[treePath]
    if (data === undefined) continue
    for (const line of new TextDecoder().decode(data).split('\n')) {
      if (line !== '') events.push(JSON.parse(line) as unknown)
    }
  }
  events.sort(
    (a, b) =>
      (((a as AnyDict).timestamp as number | undefined) ?? 0) -
      (((b as AnyDict).timestamp as number | undefined) ?? 0),
  )
  return events
}

export function treeInputsFromState(state: WorkspaceStateDict): TreeInputs {
  const entries: Record<string, Uint8Array> = {}
  const mountsMeta: AnyDict[] = []
  for (const mount of state.mounts as unknown as AnyDict[]) {
    const prefix = mount.prefix as string
    const resourceState = { ...(mount.resource_state as AnyDict) }
    const files = (resourceState.files as Record<string, Uint8Array> | undefined) ?? {}
    delete resourceState.files
    for (const [rel, data] of Object.entries(files)) entries[treePath(prefix, rel)] = data
    mountsMeta.push({
      index: mount.index,
      prefix,
      mode: mount.mode,
      resourceClass: mount.resource_class,
      resourceState,
    })
  }

  entries[SESSIONS_PATH] = jsonBlob({ sessions: state.sessions })
  entries[NAMESPACE_PATH] = jsonBlob({ nodes: state.nodes ?? {} })
  Object.assign(entries, historyEntries((state.history as unknown[] | undefined) ?? []))
  const cache = state.cache as unknown as { limit: number }
  const meta: VersionMeta = {
    version: state.version,
    mounts: mountsMeta,
    cache: { limit: cache.limit, entries: [] },
    fingerprints: (state.fingerprints as unknown[] | undefined) ?? [],
    liveOnlyMounts: state.live_only_mounts ?? [],
    defaultSessionId: state.default_session_id,
  }
  return { entries, meta }
}

export function toState(
  entries: Record<string, Uint8Array>,
  meta: VersionMeta,
): WorkspaceStateDict {
  const mounts: AnyDict[] = []
  for (const mount of meta.mounts) {
    const prefix = mount.prefix as string
    const treePrefix = stripSlashes(prefix)
    const resourceState = { ...(mount.resourceState as AnyDict) }
    const files: Record<string, Uint8Array> = {}
    for (const [tp, data] of Object.entries(entries)) {
      if (isReserved(tp)) continue
      if (belongs(treePrefix, tp)) files[relPath(prefix, tp)] = data
    }
    resourceState.files = files
    mounts.push({
      index: mount.index,
      prefix,
      mode: mount.mode,
      resource_class: mount.resourceClass,
      resource_state: resourceState,
    })
  }

  const sessionsBlob = entries[SESSIONS_PATH]
  const sessions = sessionsBlob !== undefined ? (parseJsonBlob(sessionsBlob).sessions ?? []) : []
  const namespaceBlob = entries[NAMESPACE_PATH]
  const nodes = namespaceBlob !== undefined ? (parseJsonBlob(namespaceBlob).nodes ?? {}) : {}
  const history = historyFromEntries(entries)
  return {
    version: meta.version,
    mounts,
    cache: { limit: meta.cache.limit, entries: [] },
    sessions,
    nodes,
    history,
    jobs: [],
    fingerprints: meta.fingerprints,
    live_only_mounts: meta.liveOnlyMounts,
    default_session_id: meta.defaultSessionId,
  } as unknown as WorkspaceStateDict
}
