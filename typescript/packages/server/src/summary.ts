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
  HISTORY_PREFIX,
  normMountPrefix,
  type Resource,
  type Workspace,
} from '@struktoai/mirage-core'
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

function describeResource(resource: Resource): string {
  const raw = resource.prompt ?? ''
  if (raw.length <= DESCRIPTION_MAX) return raw
  return raw.slice(0, DESCRIPTION_MAX - 1).trimEnd() + '\u2026'
}

async function buildInternals(ws: Workspace): Promise<WorkspaceInternals> {
  const cache = ws.cache
  return {
    cacheBytes: cache.cacheSize,
    cacheEntries: cache.cacheEntries ?? null,
    historyLength: (await ws.history()).length,
    inFlightJobs: ws.jobTable.listJobs().length,
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
    resource: m.resource.kind,
    mode: m.mode,
    description: describeResource(m.resource),
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
