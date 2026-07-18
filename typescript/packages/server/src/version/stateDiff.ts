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

import { readVersion, resolveRef, versionDiff } from './api.ts'
import { toState, type AnyDict } from './stateTree.ts'
import type { VersionStore } from './store.ts'

interface DictDelta {
  added: AnyDict
  deleted: AnyDict
  modified: Record<string, { from: unknown; to: unknown }>
}

interface SessionsDiff {
  added: string[]
  deleted: string[]
  modified: Record<string, AnyDict>
}

function dictDelta(before: AnyDict, after: AnyDict): DictDelta {
  const added: AnyDict = {}
  const deleted: AnyDict = {}
  const modified: Record<string, { from: unknown; to: unknown }> = {}
  for (const k of Object.keys(after)) {
    if (!(k in before)) added[k] = after[k]
  }
  for (const k of Object.keys(before)) {
    if (!(k in after)) deleted[k] = before[k]
    else if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      modified[k] = { from: before[k], to: after[k] }
    }
  }
  return { added, deleted, modified }
}

function isEmpty(delta: DictDelta): boolean {
  return (
    Object.keys(delta.added).length === 0 &&
    Object.keys(delta.deleted).length === 0 &&
    Object.keys(delta.modified).length === 0
  )
}

function sessionDelta(before: AnyDict, after: AnyDict): AnyDict {
  const out: AnyDict = {}
  const env = dictDelta(
    (before.env as AnyDict | undefined) ?? {},
    (after.env as AnyDict | undefined) ?? {},
  )
  if (!isEmpty(env)) out.env = env
  const grants = dictDelta(
    (before.mount_modes as AnyDict | undefined) ?? {},
    (after.mount_modes as AnyDict | undefined) ?? {},
  )
  if (!isEmpty(grants)) out.mount_modes = grants
  if (before.cwd !== after.cwd) out.cwd = { from: before.cwd, to: after.cwd }
  return out
}

function sessionsDiff(before: AnyDict[], after: AnyDict[]): SessionsDiff {
  const a = new Map(before.map((s) => [s.session_id as string, s]))
  const b = new Map(after.map((s) => [s.session_id as string, s]))
  const modified: Record<string, AnyDict> = {}
  for (const [sid, sb] of a) {
    const sa = b.get(sid)
    if (sa === undefined) continue
    const delta = sessionDelta(sb, sa)
    if (Object.keys(delta).length > 0) modified[sid] = delta
  }
  return {
    added: [...b.keys()].filter((sid) => !a.has(sid)).sort(),
    deleted: [...a.keys()].filter((sid) => !b.has(sid)).sort(),
    modified,
  }
}

// The command trail from state A to state B: events in B's history that
// A does not already contain (identity by full event content, so
// replays and clears stay honest).
function commandsBetween(historyA: AnyDict[], historyB: AnyDict[]): AnyDict[] {
  const key = (e: AnyDict): string =>
    JSON.stringify(Object.entries(e).sort(([x], [y]) => (x < y ? -1 : 1)))
  const seen = new Set(historyA.map(key))
  return historyB.filter((e) => !seen.has(key(e)))
}

/**
 * The structured difference, category by category, between two versions.
 *
 * The judge's evidence surface: files (content), sessions (env
 * references, mount grants with from/to, cwd), namespace nodes
 * (symlinks and overlays), and the commands that ran between the two
 * states. Wire shape is plain snake_case JSON with git's
 * added/modified/deleted vocabulary at every level. Mirrors the
 * Python state_diff.
 */
export async function stateDiff(store: VersionStore, refA: string, refB: string): Promise<AnyDict> {
  const versionA = await resolveRef(store, refA)
  const versionB = await resolveRef(store, refB)
  const a = await readVersion(store, versionA)
  const b = await readVersion(store, versionB)
  const stateA = toState(a.entries, a.meta) as unknown as AnyDict
  const stateB = toState(b.entries, b.meta) as unknown as AnyDict

  const sessions = sessionsDiff(
    (stateA.sessions as AnyDict[] | undefined) ?? [],
    (stateB.sessions as AnyDict[] | undefined) ?? [],
  )
  return {
    files: await versionDiff(store, versionA, versionB),
    sessions,
    namespace: dictDelta(
      (stateA.nodes as AnyDict | undefined) ?? {},
      (stateB.nodes as AnyDict | undefined) ?? {},
    ),
    commands: commandsBetween(
      (stateA.history as AnyDict[] | undefined) ?? [],
      (stateB.history as AnyDict[] | undefined) ?? [],
    ),
  }
}
