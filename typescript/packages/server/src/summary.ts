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

import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { HISTORY_PREFIX } from '@struktoai/mirage-core/vfs/history/history'
import { normMountPrefix } from '@struktoai/mirage-core/workspace/snapshot/utils'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import type { WorkspaceEntry } from './registry.ts'
import type {
  MountSummary,
  SessionSummary,
  WorkspaceBrief,
  WorkspaceDetail,
  WorkspaceInternals,
} from './schemas.ts'

const AUTO_PREFIXES = new Set(['/dev/', normMountPrefix(HISTORY_PREFIX)])
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
export function describeVfs(vfs: VFS): string {
  const raw = vfs.prompt ?? ''
  const points = Array.from(raw)
  if (points.length <= DESCRIPTION_MAX) return raw
  const cut = points.slice(0, DESCRIPTION_MAX - 1).join('')
  return cut.trimEnd() + '\u2026'
}

async function buildInternals(ws: Workspace): Promise<WorkspaceInternals> {
  const cache = ws.cache
  return {
    cacheBytes: cache.cacheSize,
    cacheEntries: cache.cacheEntries ?? null,
    historyLength: (await ws.history()).length,
    inFlightJobs: ws.jobTable.allJobs().length,
  }
}

export function makeBrief(entry: WorkspaceEntry): WorkspaceBrief {
  const ws = entry.runner.ws
  const mounts = userMounts(ws)
  return {
    id: entry.id,
    mode: mounts[0]?.mode ?? 'read',
    mountCount: mounts.length,
    sessionCount: ws.listSessions().length,
    createdAt: entry.createdAt,
  }
}

export async function makeDetail(entry: WorkspaceEntry, verbose = false): Promise<WorkspaceDetail> {
  const ws = entry.runner.ws
  const mounts = userMounts(ws)
  const mountSummaries: MountSummary[] = mounts.map((m) => ({
    prefix: m.prefix,
    vfs: m.vfs.kind,
    mode: m.mode,
    description: describeVfs(m.vfs),
  }))
  const sessions: SessionSummary[] = ws.listSessions().map((s) => ({
    sessionId: s.sessionId,
    cwd: s.cwd,
  }))
  const fuseMountpoints = (ws as { fuseMountpoints?: Record<string, string> }).fuseMountpoints ?? {}
  return {
    id: entry.id,
    mode: mounts[0]?.mode ?? 'read',
    createdAt: entry.createdAt,
    fuseMountpoints,
    mounts: mountSummaries,
    sessions,
    internals: verbose ? await buildInternals(ws) : null,
  }
}
