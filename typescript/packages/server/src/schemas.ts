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

import { loadWorkspaceConfig, type WorkspaceConfigRaw } from '@struktoai/mirage-core/config'
import type { JsonValue } from '@struktoai/mirage-core/types'
import { z } from '@struktoai/mirage-core/vfs/secrets'
import type { OverrideShape } from './clone.ts'

export interface MountSummary {
  prefix: string
  vfs: string
  mode: string
  description: string
}

/** Running while the server holds it in memory; stopped while only its config and state are kept. */
type WorkspaceStatus = 'running' | 'stopped'

export interface WorkspaceBrief {
  id: string
  status: WorkspaceStatus
  mode: string
  mount_count: number
  session_count: number
  created_at: number
}

export interface SessionSummary {
  session_id: string
  cwd: string
}

export interface WorkspaceInternals {
  cache_bytes: number | null
  cache_entries: number | null
  history_length: number
  in_flight_jobs: number
}

export interface WorkspaceDetail {
  id: string
  status: WorkspaceStatus
  mode: string
  created_at: number
  fuse_mountpoints: Record<string, string>
  system_time: string | null
  sessions: SessionSummary[]
  mounts: MountSummary[]
  internals: WorkspaceInternals | null
}

/** A workspace to create: from `config`, or from the saved `template` of that name, never both. */
export interface CreateWorkspaceRequest {
  config?: Record<string, unknown> | null
  template?: string
  id?: string
}

/**
 * A workspace config checked as a create checks one, taken as written: the
 * caller's CLI expanded its `${VAR}` in the caller's env, and the server's
 * env is not a tenant's to read. Throws an Error naming what is wrong.
 */
export function checkConfig(config: unknown): WorkspaceConfigRaw {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a mapping')
  }
  const cfg = loadWorkspaceConfig(config as Record<string, unknown>, null)
  for (const entry of cfg.runtimes ?? []) {
    if (typeof entry === 'string') continue
    const runtimeConfig = entry.config
    if (
      runtimeConfig !== null &&
      typeof runtimeConfig === 'object' &&
      Object.hasOwn(runtimeConfig, 'initModule')
    ) {
      throw new Error('runtime initModule is only allowed in operator-owned configuration')
    }
  }
  return cfg
}

export interface CreateTemplateRequest {
  name: string
  description?: string | null
  config: Record<string, unknown>
}

export interface TemplateResponse {
  name: string
  description: string | null
  config: Record<string, JsonValue>
}

export interface CloneWorkspaceRequest {
  id?: string
  override?: OverrideShape
}

export const SnapshotWorkspaceRequest = z.object({ key: z.string() }).strict()

export interface LoadWorkspaceRequest {
  key?: string
  id?: string
  override?: OverrideShape
}
