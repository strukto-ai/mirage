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

import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { BIN_PREFIX } from '@struktoai/mirage-core/shell/constants'
import { HISTORY_PREFIX } from '@struktoai/mirage-core/vfs/history/history'
import { MountBackend, parseMountMode, type JsonValue } from '@struktoai/mirage-core/types'
import { isPlainObject } from '@struktoai/mirage-core/utils/records'
import { normDir } from '@struktoai/mirage-core/utils/slash'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { WorkspaceEntry } from './registry.ts'
import type {
  MountSummary,
  SessionSummary,
  WorkspaceBrief,
  WorkspaceDetail,
  WorkspaceInternals,
} from './schemas.ts'

const AUTO_PREFIXES = new Set(['/dev/', normDir(HISTORY_PREFIX), normDir(BIN_PREFIX)])
const DESCRIPTION_MAX = 120

function isAutoPrefix(prefix: string): boolean {
  return AUTO_PREFIXES.has(prefix)
}

function userMounts(ws: Workspace) {
  return ws.mounts().filter((m) => !isAutoPrefix(m.prefix))
}

/**
 * Shorten a VFS's prompt to the description budget.
 *
 * The budget counts characters, which python's `len` reads as code points and
 * `String.length` reads as UTF-16 units. Measuring in units would ellipsize a
 * prompt python leaves whole and could cut a surrogate pair in half, so this
 * measures and slices `Array.from` -- the same fix `sanitizeLabel` carries.
 */
export function describeVfs(vfs: BaseVFS): string {
  const raw = vfs.vfsMd
  const points = Array.from(raw)
  if (points.length <= DESCRIPTION_MAX) return raw
  const cut = points.slice(0, DESCRIPTION_MAX - 1).join('')
  return cut.trimEnd() + '\u2026'
}

async function buildInternals(ws: Workspace): Promise<WorkspaceInternals> {
  const cache = ws.cache
  return {
    cache_bytes: cache.cacheSize,
    cache_entries: cache.cacheEntries ?? null,
    history_length: (await ws.observer.commandEvents()).length,
    in_flight_jobs: ws.jobTable.allRunningJobs().length,
  }
}

export function makeBrief(entry: WorkspaceEntry): WorkspaceBrief {
  return { id: entry.id, status: 'running', created_at: entry.createdAt }
}

/** A kernel-mount map keyed by directory prefix, as mounts list theirs. */
function byDir<T>(map: Record<string, T>): Map<string, T> {
  return new Map(Object.entries(map).map(([k, v]) => [normDir(k), v]))
}

export async function makeDetail(entry: WorkspaceEntry, verbose = false): Promise<WorkspaceDetail> {
  const ws = entry.runner.ws
  const mounts = userMounts(ws)
  const kernel = ws as {
    fuseMountpoints?: Record<string, string>
    kernelBackends?: Record<string, MountBackend>
  }
  const points = byDir(kernel.fuseMountpoints ?? {})
  const backends = byDir(kernel.kernelBackends ?? {})
  const mountSummaries: MountSummary[] = mounts.map((m) => ({
    prefix: m.prefix,
    vfs: m.vfs.name,
    mode: m.mode,
    description: describeVfs(m.vfs),
    backend: backends.get(m.prefix) ?? MountBackend.WORKSPACE,
    mountpoint: points.get(m.prefix) ?? null,
  }))
  const sessions: SessionSummary[] = ws.listSessions().map((s) => ({
    session_id: s.sessionId,
    cwd: s.cwd,
  }))
  return {
    id: entry.id,
    status: 'running',
    created_at: entry.createdAt,
    system_time: ws.systemTime,
    mounts: mountSummaries,
    sessions,
    internals: verbose ? await buildInternals(ws) : null,
  }
}

/**
 * The mounts a stopped workspace's config names, as a running one's would
 * list them, longest prefix first: a mount with no mode of its own takes
 * the config's, write by default.
 */
function configMounts(config: Record<string, JsonValue> | null): MountSummary[] {
  const mounts = config?.mounts
  if (!isPlainObject(mounts)) return []
  const mode = modeOf(config?.mode, 'write')
  return Object.entries(mounts)
    .map(([prefix, mount]) => {
      const spec = isPlainObject(mount) ? mount : {}
      return {
        prefix: normDir(prefix),
        vfs: typeof spec.vfs === 'string' ? spec.vfs : '',
        mode: modeOf(spec.mode, mode),
        description: '',
        backend: backendOf(spec.backend),
        mountpoint: null,
      }
    })
    .filter((m) => !isAutoPrefix(m.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)
}

/** The backend a saved config's mount names, `workspace` when it names none. */
function backendOf(value: JsonValue | undefined): MountBackend {
  if (typeof value !== 'string' || value === '') return MountBackend.WORKSPACE
  const known = Object.values(MountBackend) as string[]
  if (known.includes(value.toLowerCase())) return value.toLowerCase() as MountBackend
  console.debug(`mirage: a saved config's backend did not parse: ${value}`)
  return MountBackend.WORKSPACE
}

/**
 * A mode as a running workspace names it, an alias such as `rw` read as
 * `write`; `fallback` when the config gives none.
 */
function modeOf(value: JsonValue | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback
  try {
    return parseMountMode(value.toLowerCase())
  } catch (e) {
    console.debug(`mirage: a saved config's mount mode did not parse: ${(e as Error).message}`)
    return value.toLowerCase()
  }
}

/**
 * A stopped workspace's brief, from when it was first created. Mirrors
 * Python's `make_stopped_brief`.
 */
export function makeStoppedBrief(id: string, createdAt: number): WorkspaceBrief {
  return { id, status: 'stopped', created_at: createdAt }
}

/** A stopped workspace's detail, as `makeStoppedBrief`. Mirrors Python's `make_stopped_detail`. */
export function makeStoppedDetail(
  id: string,
  config: Record<string, JsonValue> | null,
  createdAt: number,
): WorkspaceDetail {
  return {
    id,
    status: 'stopped',
    created_at: createdAt,
    system_time: null,
    mounts: configMounts(config),
    sessions: [],
    internals: null,
  }
}
